use anchor_lang::prelude::*;

pub mod utils;
pub mod state;

pub mod errors;
use errors::*;

pub mod instructions;
use instructions::*;

declare_id!("moonoL26kRC8S49yPuuopKhbNhvgf2h4Dva91noD8rN");

#[program]
pub mod moono {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        instructions::ping::handle_ping(_ctx)
    }

    pub fn initialize_protocol(_ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handle_initialize_protocol(_ctx)
    }

    pub fn initialize_asset_pool(_ctx: Context<InitializeAssetPool>) -> Result<()> {
        instructions::initialize_asset_pool::handle_initialize_asset_pool(_ctx)
    }

    pub fn set_asset_pool_flags(
        ctx: Context<SetAssetPoolFlags>,
        is_enabled: bool,
        allow_deposits: bool,
        allow_borrows: bool,
    ) -> Result<()> {
        instructions::set_asset_pool_flags::handle_set_asset_pool_flags(
            ctx,
            is_enabled,
            allow_deposits,
            allow_borrows
        )
    }

    pub fn initialize_tick_page(
        ctx: Context<InitializeTickPage>,
        page_index: u32,
    ) -> Result<()> {
        instructions::initialize_tick_page::handle_initialize_tick_page(
            ctx,
            page_index
        )
    }

    pub fn mock_deposit_to_tick(
        ctx: Context<MockDepositToTick>,
        tick: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::mock_deposit_to_tick::handle_mock_deposit_to_tick(
            ctx,
            tick,
            amount
        )
    }

    pub fn deposit_to_tick(
        ctx: Context<DepositToTick>,
        tick: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_to_tick::handle_deposit_to_tick(ctx, tick, amount)
    }

    pub fn withdraw_from_tick(
        ctx: Context<WithdrawFromTick>,
        tick: u32,
        shares_to_burn: u64,
    ) -> Result<()> {
        instructions::withdraw_from_tick::handle_withdraw_from_tick(
            ctx,
            tick,
            shares_to_burn,
        )
    }
}
