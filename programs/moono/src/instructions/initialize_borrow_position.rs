use anchor_lang::prelude::*;

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, BorrowPosition, LoanPosition, ProtocolConfig, LOAN_STATUS_INITIALIZED,
};

pub fn handle_initialize_borrow_position(
    ctx: Context<InitializeBorrowPosition>,
    _loan_id: u64,
    tick: u32,
) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let asset_pool = &ctx.accounts.quote_asset_pool;
    let loan_position = &ctx.accounts.loan_position;
    let borrow_position = &mut ctx.accounts.borrow_position;

    require!(!protocol.paused, MoonoError::ProtocolPaused);
    require!(
        loan_position.owner == ctx.accounts.owner.key(),
        MoonoError::Unauthorized
    );
    require!(
        loan_position.quote_asset_pool == asset_pool.key(),
        MoonoError::InvalidLoanPosition
    );
    require!(
        loan_position.status == LOAN_STATUS_INITIALIZED,
        MoonoError::InvalidLoanStatus
    );

    borrow_position.owner = ctx.accounts.owner.key();
    borrow_position.loan_position = loan_position.key();
    borrow_position.asset_pool = asset_pool.key();
    borrow_position.tick = tick;
    borrow_position.debt_scaled = 0;

    msg!("Borrow position initialized");
    Ok(())
}

#[derive(Accounts)]
#[instruction(loan_id: u64, tick: u32)]
pub struct InitializeBorrowPosition<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump
    )]
    pub protocol: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"asset_pool", quote_asset_pool.mint.as_ref()],
        bump = quote_asset_pool.bump,
        constraint = quote_asset_pool.protocol == protocol.key()
    )]
    pub quote_asset_pool: Box<Account<'info, AssetPool>>,

    #[account(
        mut,
        seeds = [
            b"loan_position",
            owner.key().as_ref(),
            &loan_id.to_le_bytes()
        ],
        bump = loan_position.bump
    )]
    pub loan_position: Box<Account<'info, LoanPosition>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        seeds = [
            b"borrow_position",
            loan_position.key().as_ref(),
            &tick.to_le_bytes()
        ],
        bump,
        space = 8 + BorrowPosition::INIT_SPACE
    )]
    pub borrow_position: Box<Account<'info, BorrowPosition>>,

    pub system_program: Program<'info, System>,
}

#[instruction(loan_id: u64, tick: u32)]
pub struct _Phantom;
