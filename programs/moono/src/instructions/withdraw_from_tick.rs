use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoonoError;
use crate::state::{AssetPool, LpPosition, TickPage};
use crate::utils::{clear_bit, tick_to_page_index};

pub fn handle_withdraw_from_tick(
    ctx: Context<WithdrawFromTick>,
    tick: u32,
    shares_to_burn: u64,
) -> Result<()> {
    require!(shares_to_burn > 0, MoonoError::InvalidAmount);

    let asset_pool = &ctx.accounts.asset_pool;

    require!(
        ctx.accounts.user_token_account.mint == asset_pool.mint,
        MoonoError::WrongMint
    );
    require!(
        ctx.accounts.vault.key() == asset_pool.vault,
        MoonoError::WrongVault
    );

    let mut tick_page = ctx.accounts.tick_page.load_mut()?;
    let (page, index) = tick_to_page_index(tick);
    require!(
        tick_page.asset_pool == asset_pool.key() && tick_page.page_index == page,
        MoonoError::WrongTickPage
    );
    let tick_state = &mut tick_page.ticks[index];

    let lp_position = &mut ctx.accounts.lp_position;

    require!(
        lp_position.owner == ctx.accounts.owner.key(),
        MoonoError::Unauthorized
    );
    require!(
        lp_position.asset_pool == asset_pool.key(),
        MoonoError::InvalidLpPosition
    );
    require!(lp_position.tick == tick, MoonoError::InvalidLpPosition);
    require!(
        lp_position.shares >= shares_to_burn,
        MoonoError::InsufficientShares
    );
    require!(tick_state.total_shares > 0, MoonoError::InvariantViolation);
    require!(
        tick_state.available_liquidity > 0,
        MoonoError::InvariantViolation
    );

    let amount_out_u128 =
        (shares_to_burn as u128) * (tick_state.available_liquidity as u128)
            / (tick_state.total_shares as u128);

    require!(amount_out_u128 > 0, MoonoError::ZeroAmountOut);

    let amount_out =
        u64::try_from(amount_out_u128).map_err(|_| error!(MoonoError::MathOverflow))?;

    lp_position.shares = lp_position
        .shares
        .checked_sub(shares_to_burn)
        .ok_or(error!(MoonoError::MathOverflow))?;

    tick_state.total_shares = tick_state
        .total_shares
        .checked_sub(shares_to_burn)
        .ok_or(error!(MoonoError::MathOverflow))?;

    tick_state.available_liquidity = tick_state
        .available_liquidity
        .checked_sub(amount_out)
        .ok_or(error!(MoonoError::MathOverflow))?;

    if tick_state.available_liquidity == 0 {
        clear_bit(&mut tick_page.non_empty_bitmap, index);
    }

    let asset_pool_key = asset_pool.key();
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
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        transfer_accounts,
        signer,
    );

    transfer_checked(transfer_ctx, amount_out, ctx.accounts.mint.decimals)?;

    msg!("Withdraw from tick completed");
    Ok(())
}

#[derive(Accounts)]
#[instruction(tick: u32)]
pub struct WithdrawFromTick<'info> {
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

    /// CHECK: PDA authority for vault, no data is read or written
    #[account(
        seeds = [b"vault_authority", asset_pool.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

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
        mut,
        seeds = [
            b"lp_position",
            owner.key().as_ref(),
            asset_pool.key().as_ref(),
            &tick.to_le_bytes()
        ],
        bump
    )]
    pub lp_position: Account<'info, LpPosition>,

    pub token_program: Interface<'info, TokenInterface>,
}
