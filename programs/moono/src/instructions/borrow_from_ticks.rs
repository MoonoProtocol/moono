use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::{next_account_info, AccountInfo};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, BorrowPosition, LoanPosition, ProtocolConfig, TickPage, RAY,
    LOAN_STATUS_ACTIVE, LOAN_STATUS_INITIALIZED,
};
use crate::utils::tick_to_page_index;

const SECONDS_PER_YEAR: u128 = 31_536_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BorrowFill {
    pub tick: u32,
    pub amount: u64,
}

fn accrue_tick(
    tick_state: &mut crate::state::TickState,
    tick_bps: u32,
    now_ts: i64,
) -> Result<()> {
    if tick_state.borrow_index_ray == 0 {
        tick_state.borrow_index_ray = RAY;
        tick_state.last_accrual_ts = now_ts;
        return Ok(());
    }

    if now_ts <= tick_state.last_accrual_ts {
        return Ok(());
    }

    let dt = (now_ts - tick_state.last_accrual_ts) as u128;
    let rate_bps = tick_bps as u128;

    let interest_increment = RAY
        .checked_mul(rate_bps)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_mul(dt)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_div(SECONDS_PER_YEAR)
        .ok_or(error!(MoonoError::MathOverflow))?;

    let growth_factor = RAY
        .checked_add(interest_increment)
        .ok_or(error!(MoonoError::MathOverflow))?;

    tick_state.borrow_index_ray = tick_state
        .borrow_index_ray
        .checked_mul(growth_factor)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_div(RAY)
        .ok_or(error!(MoonoError::MathOverflow))?;

    tick_state.last_accrual_ts = now_ts;
    Ok(())
}


pub fn handle_borrow_from_ticks<'info>(
    ctx: anchor_lang::context::Context<'_, '_, 'info, 'info, BorrowFromTicks<'info>>,
    fills: Vec<BorrowFill>,
) -> Result<()> {
    require!(!fills.is_empty(), MoonoError::InvalidAmount);

    let protocol_paused = ctx.accounts.protocol.paused;

    let asset_pool_key = ctx.accounts.quote_asset_pool.key();
    let asset_pool_mint = ctx.accounts.quote_asset_pool.mint;
    let asset_pool_vault = ctx.accounts.quote_asset_pool.vault;
    let asset_pool_enabled = ctx.accounts.quote_asset_pool.is_enabled;
    let asset_pool_allow_borrows = ctx.accounts.quote_asset_pool.allow_borrows;

    let owner_key = ctx.accounts.owner.key();

    let loan_owner = ctx.accounts.loan_position.owner;
    let loan_quote_asset_pool = ctx.accounts.loan_position.quote_asset_pool;
    let loan_status = ctx.accounts.loan_position.status;
    let loan_position_key = ctx.accounts.loan_position.key();
    let expected_borrow_amount = ctx.accounts.loan_position.quote_borrowed_amount;

    let user_quote_token_mint = ctx.accounts.user_quote_token_account.mint;
    let vault_key = ctx.accounts.vault.key();
    let quote_mint_decimals = ctx.accounts.quote_mint.decimals;

    require!(!protocol_paused, MoonoError::ProtocolPaused);
    require!(asset_pool_enabled, MoonoError::AssetPoolDisabled);
    require!(asset_pool_allow_borrows, MoonoError::BorrowsDisabled);

    require!(loan_owner == owner_key, MoonoError::Unauthorized);
    require!(
        loan_quote_asset_pool == asset_pool_key,
        MoonoError::InvalidLoanPosition
    );
    require!(
        loan_status == LOAN_STATUS_INITIALIZED,
        MoonoError::InvalidLoanStatus
    );
    require!(user_quote_token_mint == asset_pool_mint, MoonoError::WrongMint);
    require!(vault_key == asset_pool_vault, MoonoError::WrongVault);

    let expected_remaining = fills
        .len()
        .checked_mul(2)
        .ok_or(error!(MoonoError::MathOverflow))?;
    require!(
        ctx.remaining_accounts.len() == expected_remaining,
        MoonoError::InvalidRemainingAccounts
    );

    let mut total_borrow_amount: u64 = 0;
    let now_ts = Clock::get()?.unix_timestamp;
    let mut prev_tick: Option<u32> = None;

    let remaining_accounts: &'info [AccountInfo<'info>] = ctx.remaining_accounts;
    let mut remaining_accounts_iter = remaining_accounts.iter();

    for fill in fills.iter() {
        require!(fill.amount > 0, MoonoError::InvalidAmount);

        if let Some(prev) = prev_tick {
            require!(fill.tick > prev, MoonoError::TicksNotSorted);
        }
        prev_tick = Some(fill.tick);

        total_borrow_amount = total_borrow_amount
            .checked_add(fill.amount)
            .ok_or(error!(MoonoError::MathOverflow))?;

        let remaining_tick_page_info = next_account_info(&mut remaining_accounts_iter)?;
        let remaining_borrow_position_info = next_account_info(&mut remaining_accounts_iter)?;

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

        let (expected_borrow_position_pda, _) = Pubkey::find_program_address(
            &[
                b"borrow_position",
                loan_position_key.as_ref(),
                &fill.tick.to_le_bytes(),
            ],
            &crate::ID,
        );

        require!(
            remaining_borrow_position_info.key() == expected_borrow_position_pda,
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
            accrue_tick(tick_state, fill.tick, now_ts)?;

            require!(
                tick_state.available_liquidity >= fill.amount,
                MoonoError::InsufficientLiquidity
            );

            let debt_scaled_added_u128 = (fill.amount as u128)
                .checked_mul(RAY)
                .ok_or(error!(MoonoError::MathOverflow))?
                .checked_div(tick_state.borrow_index_ray)
                .ok_or(error!(MoonoError::MathOverflow))?;

            require!(
                debt_scaled_added_u128 > 0,
                MoonoError::ZeroDebtScaledAdded
            );

            tick_state.available_liquidity = tick_state
                .available_liquidity
                .checked_sub(fill.amount)
                .ok_or(error!(MoonoError::MathOverflow))?;

            tick_state.total_debt_scaled = tick_state
                .total_debt_scaled
                .checked_add(debt_scaled_added_u128)
                .ok_or(error!(MoonoError::MathOverflow))?;

            // tick_page borrow заканчивается здесь
        }

        let mut borrow_position =
            Account::<BorrowPosition>::try_from(remaining_borrow_position_info)?;

        require!(
            borrow_position.owner == owner_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_position.loan_position == loan_position_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_position.asset_pool == asset_pool_key,
            MoonoError::InvalidBorrowPosition
        );
        require!(
            borrow_position.tick == fill.tick,
            MoonoError::InvalidBorrowPosition
        );

        let debt_scaled_added_u128 = {
            let tick_page_loader =
                AccountLoader::<TickPage>::try_from(remaining_tick_page_info)?;
            let tick_page = tick_page_loader.load()?;
            let tick_state = &tick_page.ticks[index];

            (fill.amount as u128)
                .checked_mul(RAY)
                .ok_or(error!(MoonoError::MathOverflow))?
                .checked_div(tick_state.borrow_index_ray)
                .ok_or(error!(MoonoError::MathOverflow))?
        };

        borrow_position.debt_scaled = borrow_position
            .debt_scaled
            .checked_add(debt_scaled_added_u128)
            .ok_or(error!(MoonoError::MathOverflow))?;
    }

    require!(
        total_borrow_amount == expected_borrow_amount,
        MoonoError::BorrowPlanMismatch
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
        from: ctx.accounts.vault.to_account_info(),
        mint: ctx.accounts.quote_mint.to_account_info(),
        to: ctx.accounts.user_quote_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        transfer_accounts,
        signer,
    );

    transfer_checked(transfer_ctx, total_borrow_amount, quote_mint_decimals)?;

    ctx.accounts.loan_position.status = LOAN_STATUS_ACTIVE;

    msg!("Borrow from ticks completed");
    Ok(())
}

#[derive(Accounts)]
pub struct BorrowFromTicks<'info> {
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

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub user_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

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
        constraint = loan_position.quote_asset_pool == quote_asset_pool.key()
    )]
    pub loan_position: Box<Account<'info, LoanPosition>>,

    pub token_program: Interface<'info, TokenInterface>,
}
