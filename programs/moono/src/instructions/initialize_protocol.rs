use anchor_lang::prelude::*;

use crate::state::ProtocolConfig;

pub fn handle_initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;

    protocol.version = 1;
    protocol.bump = ctx.bumps.protocol;
    protocol.authority = ctx.accounts.authority.key();
    protocol.paused = false;

    msg!("Protocol initialized");

    Ok(())
}


#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        seeds = [b"protocol"],
        bump,
        space = 8 + ProtocolConfig::INIT_SPACE
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
