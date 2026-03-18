use anchor_lang::prelude::*;

use crate::state::*;
use crate::utils::*;

pub fn handle_mock_deposit_to_tick(
    ctx: Context<MockDepositToTick>,
    tick: u32,
    amount: u64,
) -> Result<()> {
    let tick_page = &mut ctx.accounts.tick_page;

    let (_page, index) = tick_to_page_index(tick);
    let tick_state = &mut tick_page.ticks[index];

    tick_state.available_liquidity += amount;
    tick_state.total_shares += amount;

    set_bit(&mut tick_page.non_empty_bitmap, index);

    msg!("Deposited into tick");

    Ok(())
}

#[derive(Accounts)]
pub struct MockDepositToTick<'info> {
    #[account(
        mut,
        seeds = [
            b"tick_page",
            asset_pool.key().as_ref(),
            &tick_page.page_index.to_le_bytes()
        ],
        bump = tick_page.bump,
        constraint = tick_page.asset_pool == asset_pool.key()
    )]
    pub tick_page: Box<Account<'info, TickPage>>,

    pub asset_pool: Account<'info, AssetPool>,
}

