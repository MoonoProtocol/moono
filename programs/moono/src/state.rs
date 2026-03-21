use anchor_lang::prelude::*;

pub const PAGE_SIZE: usize = 32;
pub const PAGE_SIZE_U32: u32 = 32;
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;

pub const TICK_STATE_SIZE: usize = 64;
pub const TICK_PAGE_HEADER_SIZE: usize = 48;
pub const TICK_PAGE_SIZE: usize = 8 + TICK_PAGE_HEADER_SIZE + (TICK_STATE_SIZE * PAGE_SIZE);

pub const MODE_PUMP_FUN: u8 = 1;
pub const MODE_METEORA: u8 = 2;
pub const MODE_PUMP_SWAP: u8 = 3;

pub const LOAN_STATUS_INITIALIZED: u8 = 1;
pub const LOAN_STATUS_EXECUTED: u8 = 2;
pub const LOAN_STATUS_ACTIVE: u8 = 3;
pub const LOAN_STATUS_REPAID: u8 = 4;
pub const LOAN_STATUS_CLOSED: u8 = 5;
pub const LOAN_STATUS_LIQUIDATED: u8 = 6;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub bump: u8,
    pub authority: Pubkey,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct AssetPool {
    pub version: u8,
    pub bump: u8,
    pub protocol: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub is_enabled: bool,
    pub allow_deposits: bool,
    pub allow_borrows: bool,
    pub decimals: u8,
}

#[zero_copy]
#[repr(C)]
pub struct TickState {
    pub total_debt_scaled: u128,
    pub borrow_index_ray: u128,
    pub total_shares: u64,
    pub available_liquidity: u64,
    pub last_accrual_ts: i64,
    pub _padding: [u8; 8],
}

#[account(zero_copy)]
#[repr(C)]
pub struct TickPage {
    pub asset_pool: Pubkey,
    pub non_empty_bitmap: u64,
    pub page_index: u32,
    pub bump: u8,
    pub _padding: [u8; 3],
    pub ticks: [TickState; PAGE_SIZE],
}

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub owner: Pubkey,
    pub asset_pool: Pubkey,
    pub tick: u32,
    pub shares: u64,
}


#[account]
#[derive(InitSpace)]
pub struct BorrowPosition {
    pub owner: Pubkey,
    pub loan_position: Pubkey,
    pub asset_pool: Pubkey,
    pub tick: u32,
    pub debt_scaled: u128,
}

#[account]
#[derive(InitSpace)]
pub struct ExecutionStrategyConfig {
    pub version: u8,
    pub bump: u8,

    pub mode: u8,
    pub is_enabled: bool,

    pub extra_quote_collateral_bps: u16,
    pub max_quote_loss_bps: u16,

    pub min_quote_buffer_amount: u64,
    pub fixed_migration_cost_quote: u64,

    pub reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct LoanPosition {
    pub version: u8,
    pub bump: u8,

    pub owner: Pubkey,

    pub quote_asset_pool: Pubkey,
    pub quote_borrowed_amount: u64,

    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub collateral_amount: u64,

    pub quote_buffer_vault: Pubkey,
    pub quote_buffer_amount: u64,

    pub strategy_mode: u8,
    pub status: u8,

    pub strategy_config: Pubkey,

    pub extra_quote_collateral_bps_snapshot: u16,
    pub max_quote_loss_bps_snapshot: u16,

    pub min_quote_buffer_amount_snapshot: u64,
    pub fixed_migration_cost_quote_snapshot: u64,

    pub created_at: i64,

    pub reserved: [u8; 16],
}

