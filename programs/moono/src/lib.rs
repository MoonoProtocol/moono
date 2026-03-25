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

    pub fn set_protocol_paused(
        ctx: Context<SetProtocolPaused>,
        paused: bool,
    ) -> Result<()> {
        instructions::set_protocol_paused::handle_set_protocol_paused(ctx, paused)
    }

    pub fn initialize_execution_strategy_config(
        ctx: Context<InitializeExecutionStrategyConfig>,
        mode: u8,
        extra_quote_collateral_bps: u16,
        max_quote_loss_bps: u16,
        min_quote_buffer_amount: u64,
        fixed_migration_cost_quote: u64,
    ) -> Result<()> {
        instructions::initialize_execution_strategy_config::handle_initialize_execution_strategy_config(
            ctx,
            mode,
            extra_quote_collateral_bps,
            max_quote_loss_bps,
            min_quote_buffer_amount,
            fixed_migration_cost_quote,
        )
    }

    pub fn set_execution_strategy_config(
        ctx: Context<SetExecutionStrategyConfig>,
        is_enabled: bool,
        extra_quote_collateral_bps: u16,
        max_quote_loss_bps: u16,
        min_quote_buffer_amount: u64,
        fixed_migration_cost_quote: u64,
    ) -> Result<()> {
        instructions::set_execution_strategy_config::handle_set_execution_strategy_config(
            ctx,
            is_enabled,
            extra_quote_collateral_bps,
            max_quote_loss_bps,
            min_quote_buffer_amount,
            fixed_migration_cost_quote,
        )
    }

    pub fn open_loan(
        ctx: Context<OpenLoan>,
        loan_id: u64,
        route_plan_hash: [u8; 32],
        planned_slice_count: u16,
        requested_quote_amount: u64,
        funded_quote_amount: u64,
        extra_user_quote_amount: u64,
        term_sec: u64,
        total_upfront_interest_paid: u64,
        total_protocol_fee_paid: u64,
        total_platform_cost_paid: u64,
    ) -> Result<()> {
        instructions::open_loan::handle_open_loan(
            ctx,
            loan_id,
            route_plan_hash,
            planned_slice_count,
            requested_quote_amount,
            funded_quote_amount,
            extra_user_quote_amount,
            term_sec,
            total_upfront_interest_paid,
            total_protocol_fee_paid,
            total_platform_cost_paid,
        )
    }

    pub fn initialize_borrow_slice_position(
        ctx: Context<InitializeBorrowSlicePosition>,
        loan_id: u64,
        tick: u32,
    ) -> Result<()> {
        let _ = loan_id;
        instructions::initialize_borrow_slice_position::handle_initialize_borrow_slice_position(
            ctx,
            tick,
        )
    }

    pub fn fund_loan_from_ticks<'info>(
        ctx: Context<'_, '_, 'info, 'info, FundLoanFromTicks<'info>>,
        fills: Vec<FundLoanFill>,
    ) -> Result<()> {
        instructions::fund_loan_from_ticks::handle_fund_loan_from_ticks(ctx, fills)
    }

    pub fn execute_launch_pump_fun(
        ctx: Context<ExecuteLaunchPumpFun>,
        use_create_v2: bool,
        name: String,
        symbol: String,
        uri: String,
        loan_quote_spend_amount: u64,
        extra_user_quote_spend_amount: u64,
        collateral_min_base_out: u64,
        immediate_user_min_base_out: u64,
    ) -> Result<()> {
        instructions::execute_launch_pump_fun::handle_execute_launch_pump_fun(
            ctx,
            use_create_v2,
            name,
            symbol,
            uri,
            loan_quote_spend_amount,
            extra_user_quote_spend_amount,
            collateral_min_base_out,
            immediate_user_min_base_out,
        )
    }
}
