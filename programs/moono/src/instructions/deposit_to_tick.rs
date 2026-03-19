use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoonoError;
use crate::state::{AssetPool, LpPosition, TickPage};
use crate::utils::{set_bit, tick_to_page_index};

pub fn handle_deposit_to_tick(
    ctx: Context<DepositToTick>,
    tick: u32,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, MoonoError::InvalidAmount);

    let asset_pool = &ctx.accounts.asset_pool;
    require!(asset_pool.is_enabled, MoonoError::AssetPoolDisabled);
    require!(asset_pool.allow_deposits, MoonoError::DepositsDisabled);
    require!(
        ctx.accounts.user_token_account.mint == asset_pool.mint,
        MoonoError::WrongMint
    );
    require!(
        ctx.accounts.vault.key() == asset_pool.vault,
        MoonoError::WrongVault
    );

    let transfer_accounts = TransferChecked {
        from: ctx.accounts.user_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        transfer_accounts,
    );

    transfer_checked(transfer_ctx, amount, ctx.accounts.mint.decimals)?;

    let mut tick_page = ctx.accounts.tick_page.load_mut()?;
    let (_page, index) = tick_to_page_index(tick);
    let tick_state = &mut tick_page.ticks[index];

    let shares = if tick_state.total_shares == 0 {
        amount
    } else {
        require!(
            tick_state.available_liquidity > 0,
            MoonoError::InvariantViolation
        );

        let shares_u128 =
            (amount as u128) * (tick_state.total_shares as u128)
                / (tick_state.available_liquidity as u128);

        require!(shares_u128 > 0, MoonoError::ZeroSharesMinted);

        u64::try_from(shares_u128).map_err(|_| error!(MoonoError::MathOverflow))?
    };

    let lp_position = &mut ctx.accounts.lp_position;

    if lp_position.owner == Pubkey::default() {
        lp_position.owner = ctx.accounts.owner.key();
        lp_position.asset_pool = asset_pool.key();
        lp_position.tick = tick;
        lp_position.shares = 0;
    } else {
        require!(
            lp_position.owner == ctx.accounts.owner.key()
                && lp_position.asset_pool == asset_pool.key()
                && lp_position.tick == tick,
            MoonoError::InvalidLpPosition
        );
    }

    tick_state.available_liquidity = tick_state
        .available_liquidity
        .checked_add(amount)
        .ok_or(error!(MoonoError::MathOverflow))?;

    tick_state.total_shares = tick_state
        .total_shares
        .checked_add(shares)
        .ok_or(error!(MoonoError::MathOverflow))?;

    lp_position.shares = lp_position
        .shares
        .checked_add(shares)
        .ok_or(error!(MoonoError::MathOverflow))?;

    set_bit(&mut tick_page.non_empty_bitmap, index);

    msg!("Deposit to tick completed");
    Ok(())
}

#[derive(Accounts)]
#[instruction(tick: u32)]
pub struct DepositToTick<'info> {
    #[account(
        mut,
        seeds = [b"asset_pool", asset_pool.mint.as_ref()],
        bump = asset_pool.bump
    )]
    pub asset_pool: Account<'info, AssetPool>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", asset_pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub tick_page: AccountLoader<'info, TickPage>,

    #[account(
        init_if_needed,
        payer = owner,
        seeds = [
            b"lp_position",
            owner.key().as_ref(),
            asset_pool.key().as_ref(),
            &tick.to_le_bytes()
        ],
        bump,
        space = 8 + LpPosition::INIT_SPACE
    )]
    pub lp_position: Account<'info, LpPosition>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}