use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, ExecutionStrategyConfig, LoanPosition, ProtocolConfig,
    LOAN_STATUS_OPENED,
};

pub fn handle_open_loan(
    ctx: Context<OpenLoan>,
    loan_id: u64,
    requested_quote_amount: u64,
    funded_quote_amount: u64,
    term_sec: u64,
    total_upfront_interest_paid: u64,
    total_protocol_fee_paid: u64,
    total_platform_cost_paid: u64,
) -> Result<()> {
    require!(requested_quote_amount > 0, MoonoError::InvalidAmount);
    require!(funded_quote_amount > 0, MoonoError::InvalidAmount);
    require!(term_sec > 0, MoonoError::InvalidAmount);

    let protocol = &ctx.accounts.protocol;
    let quote_asset_pool = &ctx.accounts.quote_asset_pool;
    let strategy_config = &ctx.accounts.strategy_config;
    let loan_position = &mut ctx.accounts.loan_position;

    require!(!protocol.paused, MoonoError::ProtocolPaused);
    require!(quote_asset_pool.is_enabled, MoonoError::AssetPoolDisabled);
    require!(quote_asset_pool.allow_borrows, MoonoError::BorrowsDisabled);
    require!(strategy_config.is_enabled, MoonoError::StrategyDisabled);

    require!(
        ctx.accounts.user_quote_token_account.mint == quote_asset_pool.mint,
        MoonoError::WrongMint
    );
    require!(
        ctx.accounts.quote_mint.key() == quote_asset_pool.mint,
        MoonoError::WrongMint
    );

    let percent_buffer_u128 = (funded_quote_amount as u128)
        .checked_mul(strategy_config.extra_quote_collateral_bps as u128)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_div(10_000u128)
        .ok_or(error!(MoonoError::MathOverflow))?;

    let percent_buffer =
        u64::try_from(percent_buffer_u128).map_err(|_| error!(MoonoError::MathOverflow))?;

    let base_buffer = percent_buffer.max(strategy_config.min_quote_buffer_amount);

    let required_quote_buffer_amount = base_buffer
        .checked_add(strategy_config.fixed_migration_cost_quote)
        .ok_or(error!(MoonoError::MathOverflow))?;

    let total_user_quote_payment = required_quote_buffer_amount
        .checked_add(total_upfront_interest_paid)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_add(total_protocol_fee_paid)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_add(total_platform_cost_paid)
        .ok_or(error!(MoonoError::MathOverflow))?;

    // 1. Переводим quote buffer в отдельный vault займа
    if required_quote_buffer_amount > 0 {
        let transfer_accounts = TransferChecked {
            from: ctx.accounts.user_quote_token_account.to_account_info(),
            mint: ctx.accounts.quote_mint.to_account_info(),
            to: ctx.accounts.loan_quote_buffer_vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );

        transfer_checked(
            transfer_ctx,
            required_quote_buffer_amount,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

    // 2. Переводим upfront-экономику в treasury vault
    let upfront_and_fees_amount = total_upfront_interest_paid
        .checked_add(total_protocol_fee_paid)
        .ok_or(error!(MoonoError::MathOverflow))?
        .checked_add(total_platform_cost_paid)
        .ok_or(error!(MoonoError::MathOverflow))?;

    if upfront_and_fees_amount > 0 {
        let transfer_accounts = TransferChecked {
            from: ctx.accounts.user_quote_token_account.to_account_info(),
            mint: ctx.accounts.quote_mint.to_account_info(),
            to: ctx.accounts.protocol_quote_treasury_vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );

        transfer_checked(
            transfer_ctx,
            upfront_and_fees_amount,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

    let now_ts = Clock::get()?.unix_timestamp;
    let expires_at = now_ts
        .checked_add(term_sec as i64)
        .ok_or(error!(MoonoError::MathOverflow))?;

    loan_position.version = 1;
    loan_position.bump = ctx.bumps.loan_position;

    loan_position.owner = ctx.accounts.owner.key();

    loan_position.quote_asset_pool = quote_asset_pool.key();
    loan_position.strategy_config = strategy_config.key();

    loan_position.strategy_mode = strategy_config.mode;
    loan_position.status = LOAN_STATUS_OPENED;

    loan_position.requested_quote_amount = requested_quote_amount;
    loan_position.funded_quote_amount = funded_quote_amount;

    loan_position.term_sec = term_sec;
    loan_position.created_at = now_ts;
    loan_position.expires_at = expires_at;

    loan_position.total_upfront_interest_paid = total_upfront_interest_paid;
    loan_position.total_protocol_fee_paid = total_protocol_fee_paid;
    loan_position.total_platform_cost_paid = total_platform_cost_paid;

    loan_position.required_quote_buffer_amount = required_quote_buffer_amount;

    loan_position.loan_quote_vault = ctx.accounts.loan_quote_vault.key();
    loan_position.quote_buffer_vault = ctx.accounts.loan_quote_buffer_vault.key();

    loan_position.collateral_mint = Pubkey::default();
    loan_position.collateral_vault = Pubkey::default();
    loan_position.collateral_amount = 0;

    loan_position.immediate_user_base_amount = 0;

    loan_position.extra_quote_collateral_bps_snapshot =
        strategy_config.extra_quote_collateral_bps;
    loan_position.max_quote_loss_bps_snapshot =
        strategy_config.max_quote_loss_bps;

    loan_position.min_quote_buffer_amount_snapshot =
        strategy_config.min_quote_buffer_amount;
    loan_position.fixed_migration_cost_quote_snapshot =
        strategy_config.fixed_migration_cost_quote;

    loan_position.reserved = [0; 32];

    msg!("Loan opened");
    msg!("loan_id: {}", loan_id);
    msg!("required_quote_buffer_amount: {}", required_quote_buffer_amount);
    msg!("total_user_quote_payment: {}", total_user_quote_payment);

    Ok(())
}

#[derive(Accounts)]
#[instruction(loan_id: u64)]
pub struct OpenLoan<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump
    )]
    pub protocol: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"asset_pool", quote_asset_pool.mint.as_ref()],
        bump = quote_asset_pool.bump,
        constraint = quote_asset_pool.protocol == protocol.key()
    )]
    pub quote_asset_pool: Box<Account<'info, AssetPool>>,

    #[account(
        seeds = [b"strategy_config".as_ref(), &[strategy_config.mode]],
        bump = strategy_config.bump
    )]
    pub strategy_config: Box<Account<'info, ExecutionStrategyConfig>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub user_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = owner,
        seeds = [
            b"loan_position",
            owner.key().as_ref(),
            &loan_id.to_le_bytes()
        ],
        bump,
        space = 8 + LoanPosition::INIT_SPACE
    )]
    pub loan_position: Box<Account<'info, LoanPosition>>,

    /// CHECK: PDA authority for loan-owned vaults, no data is read or written
    #[account(
        seeds = [b"loan_vault_authority", loan_position.key().as_ref()],
        bump
    )]
    pub loan_vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        seeds = [b"loan_quote_vault", loan_position.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = loan_vault_authority,
        token::token_program = token_program
    )]
    pub loan_quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = owner,
        seeds = [b"loan_quote_buffer_vault", loan_position.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = loan_vault_authority,
        token::token_program = token_program
    )]
    pub loan_quote_buffer_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA authority for treasury vault, no data is read or written
    #[account(
        seeds = [b"quote_treasury_auth", quote_asset_pool.key().as_ref()],
        bump
    )]
    pub protocol_quote_treasury_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"quote_treasury_vault", quote_asset_pool.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = protocol_quote_treasury_authority,
        token::token_program = token_program
    )]
    pub protocol_quote_treasury_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
