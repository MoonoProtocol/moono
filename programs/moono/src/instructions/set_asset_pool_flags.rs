use anchor_lang::prelude::*;

use crate::MoonoError;
use crate::state::*;

pub fn handler_set_asset_pool_flags(
    ctx: Context<SetAssetPoolFlags>,
    is_enabled: bool,
    allow_deposits: bool,
    allow_borrows: bool,
) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let asset_pool = &mut ctx.accounts.asset_pool;

    require!(
        protocol.authority == ctx.accounts.authority.key(),
        MoonoError::Unauthorized
    );

    asset_pool.is_enabled = is_enabled;
    asset_pool.allow_deposits = allow_deposits;
    asset_pool.allow_borrows = allow_borrows;

    msg!("Asset pool flags updated");

    Ok(())
}

#[derive(Accounts)]
pub struct SetAssetPoolFlags<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = authority
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"asset_pool", asset_pool.mint.as_ref()],
        bump = asset_pool.bump,
        constraint = asset_pool.protocol == protocol.key()
    )]
    pub asset_pool: Account<'info, AssetPool>,

    pub authority: Signer<'info>,
}
