use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::{next_account_info, AccountInfo};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, BorrowSlicePosition, LoanPosition, ProtocolConfig, TickPage,
    LOAN_STATUS_FUNDED, LOAN_STATUS_OPENED,
};
use crate::utils::tick_to_page_index;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FundLoanFill {
    pub tick: u32,
    pub principal_amount: u64,
    pub upfront_interest_amount: u64,
    pub protocol_fee_amount: u64,
}

pub fn handle_fund_loan_from_ticks<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, FundLoanFromTicks<'info>>,
    fills: Vec<FundLoanFill>,
) -> Result<()> {
    require!(!fills.is_empty(), MoonoError::InvalidAmount);

    let accounts = &mut ctx.accounts;
    let remaining_accounts = ctx.remaining_accounts;

    let protocol_paused = accounts.protocol.paused;

    let asset_pool_key = accounts.quote_asset_pool.key();
    let asset_pool_mint = accounts.quote_asset_pool.mint;
    let asset_pool_vault = accounts.quote_asset_pool.vault;
    let asset_pool_enabled = accounts.quote_asset_pool.is_enabled;
    let asset_pool_allow_borrows = accounts.quote_asset_pool.allow_borrows;

    let owner_key = accounts.owner.key();

    let loan_owner = accounts.loan_position.owner;
    let loan_quote_asset_pool = accounts.loan_position.quote_asset_pool;
    let loan_status = accounts.loan_position.status;
    let loan_position_key = accounts.loan_position.key();
    let expected_planned_slice_count = accounts.loan_position.planned_slice_count;
    let expected_funded_quote_amount =
        accounts.loan_position.planned_total_principal_amount;
    let expected_total_upfront_interest_paid =
        accounts.loan_position.planned_total_upfront_interest_amount;
    let expected_total_protocol_fee_paid =
        accounts.loan_position.planned_total_protocol_fee_amount;
    let loan_quote_vault_key = accounts.loan_position.loan_quote_vault;

    let loan_quote_vault_account_key = accounts.loan_quote_vault.key();
    let quote_mint_key = accounts.quote_mint.key();
    let quote_mint_decimals = accounts.quote_mint.decimals;

    require!(!protocol_paused, MoonoError::ProtocolPaused);
    require!(asset_pool_enabled, MoonoError::AssetPoolDisabled);
    require!(asset_pool_allow_borrows, MoonoError::BorrowsDisabled);

    require!(loan_owner == owner_key, MoonoError::Unauthorized);
    require!(
        loan_quote_asset_pool == asset_pool_key,
        MoonoError::InvalidLoanPosition
    );
    require!(
        loan_status == LOAN_STATUS_OPENED,
        MoonoError::InvalidLoanStatus
    );
    require!(asset_pool_mint == quote_mint_key, MoonoError::WrongMint);
    require!(accounts.vault.key() == asset_pool_vault, MoonoError::WrongVault);
    require!(
        loan_quote_vault_account_key == loan_quote_vault_key,
        MoonoError::InvalidLoanPosition
    );
    require!(
        accounts.loan_quote_vault.mint == quote_mint_key,
        MoonoError::WrongMint
    );
    require!(
        fills.len() == expected_planned_slice_count as usize,
        MoonoError::BorrowPlanSliceCountMismatch
    );

    let expected_remaining = fills
        .len()
        .checked_mul(2)
        .ok_or(error!(MoonoError::MathOverflow))?;
    require!(
        remaining_accounts.len() == expected_remaining,
        MoonoError::InvalidRemainingAccounts
    );

    let mut total_principal: u64 = 0;
    let mut total_upfront_interest: u64 = 0;
    let mut total_protocol_fee: u64 = 0;

    let mut prev_tick: Option<u32> = None;
    let mut remaining_accounts_iter = remaining_accounts.iter();

    for fill in fills.iter() {
        require!(fill.principal_amount > 0, MoonoError::InvalidAmount);

        if let Some(prev) = prev_tick {
            require!(fill.tick > prev, MoonoError::TicksNotSorted);
        }
        prev_tick = Some(fill.tick);

        total_principal = total_principal
            .checked_add(fill.principal_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;
        total_upfront_interest = total_upfront_interest
            .checked_add(fill.upfront_interest_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;
        total_protocol_fee = total_protocol_fee
            .checked_add(fill.protocol_fee_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;

        let remaining_tick_page_info = next_account_info(&mut remaining_accounts_iter)?;
        let remaining_borrow_slice_info = next_account_info(&mut remaining_accounts_iter)?;

        let (page_index, index) = tick_to_page_index(fill.tick);

        let (expected_tick_page_pda, _) = Pubkey::find_program_address(
            &[
                b"tick_page",
                asset_pool_key.as_ref(),
                &page_index.to_le_bytes(),
            ],
            &crate::ID,
        );

        require!(
            remaining_tick_page_info.key() == expected_tick_page_pda,
            MoonoError::InvalidTickPage
        );

        let (expected_borrow_slice_pda, _) = Pubkey::find_program_address(
            &[
                b"borrow_position",
                loan_position_key.as_ref(),
                &fill.tick.to_le_bytes(),
            ],
            &crate::ID,
        );

        require!(
            remaining_borrow_slice_info.key() == expected_borrow_slice_pda,
            MoonoError::InvalidBorrowPosition
        );

        {
            let tick_page_loader =
                AccountLoader::<TickPage>::try_from(remaining_tick_page_info)?;
            let mut tick_page = tick_page_loader.load_mut()?;

            require!(
                tick_page.asset_pool == asset_pool_key,
                MoonoError::InvalidTickPage
            );
            require!(
                tick_page.page_index == page_index,
                MoonoError::InvalidTickPage
            );

            let tick_state = &mut tick_page.ticks[index];

            require!(
                tick_state.available_liquidity >= fill.principal_amount,
                MoonoError::InsufficientLiquidity
            );

            tick_state.available_liquidity = tick_state
                .available_liquidity
                .checked_sub(fill.principal_amount)
                .ok_or(error!(MoonoError::MathOverflow))?;

            tick_state.outstanding_principal = tick_state
                .outstanding_principal
                .checked_add(fill.principal_amount)
                .ok_or(error!(MoonoError::MathOverflow))?;

            tick_state.realized_interest_collected = tick_state
                .realized_interest_collected
                .checked_add(fill.upfront_interest_amount)
                .ok_or(error!(MoonoError::MathOverflow))?;
        }

        let mut borrow_slice =
            Account::<BorrowSlicePosition>::try_from(remaining_borrow_slice_info)?;

        require!(
            borrow_slice.owner == owner_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_slice.loan_position == loan_position_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_slice.asset_pool == asset_pool_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_slice.tick == fill.tick,
            MoonoError::InvalidBorrowPosition
        );

        borrow_slice.principal_outstanding = borrow_slice
            .principal_outstanding
            .checked_add(fill.principal_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;

        borrow_slice.upfront_interest_paid = borrow_slice
            .upfront_interest_paid
            .checked_add(fill.upfront_interest_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;

        borrow_slice.protocol_fee_paid = borrow_slice
            .protocol_fee_paid
            .checked_add(fill.protocol_fee_amount)
            .ok_or(error!(MoonoError::MathOverflow))?;

        borrow_slice.exit(&crate::ID)?;
    }

    require!(
        total_principal == expected_funded_quote_amount,
        MoonoError::BorrowPlanMismatch
    );
    require!(
        total_upfront_interest == expected_total_upfront_interest_paid,
        MoonoError::BorrowPlanInterestMismatch
    );
    require!(
        total_protocol_fee == expected_total_protocol_fee_paid,
        MoonoError::BorrowPlanProtocolFeeMismatch
    );

    let vault_authority_bump = ctx.bumps.vault_authority;
    let bump_seed = [vault_authority_bump];
    let signer_seeds: &[&[u8]] = &[
        b"vault_authority",
        asset_pool_key.as_ref(),
        &bump_seed,
    ];
    let signer: &[&[&[u8]]] = &[signer_seeds];

    let transfer_accounts = TransferChecked {
        from: accounts.vault.to_account_info(),
        mint: accounts.quote_mint.to_account_info(),
        to: accounts.loan_quote_vault.to_account_info(),
        authority: accounts.vault_authority.to_account_info(),
    };

    let transfer_ctx = CpiContext::new_with_signer(
        accounts.token_program.to_account_info(),
        transfer_accounts,
        signer,
    );

    transfer_checked(transfer_ctx, total_principal, quote_mint_decimals)?;

    accounts.loan_position.status = LOAN_STATUS_FUNDED;

    msg!("Loan funded from ticks");
    Ok(())
}

#[derive(Accounts)]
pub struct FundLoanFromTicks<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump
    )]
    pub protocol: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"asset_pool", quote_asset_pool.mint.as_ref()],
        bump = quote_asset_pool.bump,
        constraint = quote_asset_pool.protocol == protocol.key()
    )]
    pub quote_asset_pool: Box<Account<'info, AssetPool>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA authority for asset pool vault, no data is read or written
    #[account(
        seeds = [b"vault_authority", quote_asset_pool.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", quote_asset_pool.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = loan_position.owner == owner.key(),
        constraint = loan_position.quote_asset_pool == quote_asset_pool.key(),
        constraint = loan_position.loan_quote_vault == loan_quote_vault.key()
    )]
    pub loan_position: Box<Account<'info, LoanPosition>>,

    #[account(
        mut,
        seeds = [b"loan_quote_vault", loan_position.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub loan_quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
