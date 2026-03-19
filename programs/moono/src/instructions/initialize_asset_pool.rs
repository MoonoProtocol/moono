use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
};

use crate::MoonoError;
use crate::state::*;

pub fn handle_initialize_asset_pool(ctx: Context<InitializeAssetPool>) -> Result<()> {
    let asset_pool = &mut ctx.accounts.asset_pool;
    let protocol = &ctx.accounts.protocol;

    require!(
        protocol.authority == ctx.accounts.authority.key(),
        MoonoError::Unauthorized
    );

    asset_pool.version = 1;
    asset_pool.bump = ctx.bumps.asset_pool;
    asset_pool.protocol = protocol.key();
    asset_pool.mint = ctx.accounts.mint.key();
    asset_pool.vault = ctx.accounts.vault.key();
    asset_pool.is_enabled = true;
    asset_pool.allow_deposits = true;
    asset_pool.allow_borrows = true;
    asset_pool.decimals = ctx.accounts.mint.decimals;

    msg!("Asset pool initialized");

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeAssetPool<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = authority
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        seeds = [b"asset_pool", mint.key().as_ref()],
        bump,
        space = 8 + AssetPool::INIT_SPACE
    )]
    pub asset_pool: Account<'info, AssetPool>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA authority for vault, no data is read or written
    #[account(
        seeds = [b"vault_authority", asset_pool.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", asset_pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
