use anchor_lang::prelude::*;

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, BorrowSlicePosition, LoanPosition, ProtocolConfig, LOAN_STATUS_OPENED,
};

pub fn handle_initialize_borrow_slice_position(
    ctx: Context<InitializeBorrowSlicePosition>,
    tick: u32,
) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let asset_pool = &ctx.accounts.quote_asset_pool;
    let loan_position = &ctx.accounts.loan_position;
    let borrow_slice_position = &mut ctx.accounts.borrow_slice_position;

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
        loan_position.status == LOAN_STATUS_OPENED,
        MoonoError::InvalidLoanStatus
    );

    borrow_slice_position.owner = ctx.accounts.owner.key();
    borrow_slice_position.loan_position = loan_position.key();
    borrow_slice_position.asset_pool = asset_pool.key();
    borrow_slice_position.tick = tick;
    borrow_slice_position.principal_outstanding = 0;
    borrow_slice_position.upfront_interest_paid = 0;
    borrow_slice_position.protocol_fee_paid = 0;

    msg!("Borrow slice position initialized");
    Ok(())
}

#[derive(Accounts)]
#[instruction(loan_id: u64, tick: u32)]
pub struct InitializeBorrowSlicePosition<'info> {
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
        space = 8 + BorrowSlicePosition::INIT_SPACE
    )]
    pub borrow_slice_position: Box<Account<'info, BorrowSlicePosition>>,

    pub system_program: Program<'info, System>,
}
