use anchor_lang::prelude::*;

pub const PAGE_SIZE: usize = 32;
pub const PAGE_SIZE_U32: u32 = 32;
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;

pub const TICK_STATE_SIZE: usize = 64;
pub const TICK_PAGE_HEADER_SIZE: usize = 48;
pub const TICK_PAGE_SIZE: usize = 8 + TICK_PAGE_HEADER_SIZE + (TICK_STATE_SIZE * PAGE_SIZE);

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
pub struct TickState {
    pub total_debt_scaled: u128,
    pub borrow_index_ray: u128,
    pub total_shares: u64,
    pub available_liquidity: u64,
    pub last_accrual_ts: i64,
    pub _padding: [u8; 8],
}

#[account(zero_copy)]
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
