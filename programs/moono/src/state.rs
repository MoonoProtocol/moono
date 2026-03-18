use anchor_lang::prelude::*;

pub const PAGE_SIZE: usize = 32;
pub const PAGE_SIZE_U32: u32 = 32;
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;

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
    pub is_enabled: bool,
    pub allow_deposits: bool,
    pub allow_borrows: bool,
    pub decimals: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, InitSpace)]
pub struct TickState {
    pub total_shares: u64,
    pub available_liquidity: u64,
    pub total_debt_scaled: u128,
    pub borrow_index_ray: u128,
    pub last_accrual_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct TickPage {
    pub bump: u8,
    pub asset_pool: Pubkey,
    pub page_index: u32,
    pub non_empty_bitmap: u64,
    pub ticks: [TickState; PAGE_SIZE],
}
