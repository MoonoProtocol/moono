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
        instructions::ping::handler_ping(_ctx)
    }

    pub fn initialize_protocol(_ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handler_initialize_protocol(_ctx)
    }

    pub fn initialize_asset_pool(_ctx: Context<InitializeAssetPool>) -> Result<()> {
        instructions::initialize_asset_pool::handler_initialize_asset_pool(_ctx)
    }

    pub fn set_asset_pool_flags(
        ctx: Context<SetAssetPoolFlags>,
        is_enabled: bool,
        allow_deposits: bool,
        allow_borrows: bool,
    ) -> Result<()> {
        instructions::set_asset_pool_flags::handler_set_asset_pool_flags(
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
        instructions::initialize_tick_page::handler_initialize_tick_page(
            ctx,
            page_index
        )
    }

    pub fn mock_deposit_to_tick(
        ctx: Context<MockDepositToTick>,
        tick: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::mock_deposit_to_tick::handler_mock_deposit_to_tick(
            ctx,
            tick,
            amount
        )
    }
}
