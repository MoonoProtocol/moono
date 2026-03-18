use anchor_lang::prelude::*;

use crate::state::*;


pub fn handler_initialize_tick_page(
    ctx: Context<InitializeTickPage>,
    page_index: u32,
) -> Result<()> {
    let tick_page = &mut ctx.accounts.tick_page;

    tick_page.bump = ctx.bumps.tick_page;
    tick_page.asset_pool = ctx.accounts.asset_pool.key();
    tick_page.page_index = page_index;
    tick_page.non_empty_bitmap = 0;

    msg!("Tick page initialized");

    Ok(())
}

#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct InitializeTickPage<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = authority
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [b"asset_pool", asset_pool.mint.as_ref()],
        bump = asset_pool.bump,
        constraint = asset_pool.protocol == protocol.key()
    )]
    pub asset_pool: Account<'info, AssetPool>,

    #[account(
        init,
        payer = authority,
        seeds = [
            b"tick_page",
            asset_pool.key().as_ref(),
            &page_index.to_le_bytes()
        ],
        bump,
        space = 8 + TickPage::INIT_SPACE
    )]
    pub tick_page: Box<Account<'info, TickPage>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
