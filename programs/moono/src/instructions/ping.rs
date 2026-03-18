use anchor_lang::prelude::*;

pub fn handler_ping(_ctx: Context<Ping>) -> Result<()> {
    msg!("hello world");
    Ok(())
}

#[derive(Accounts)]
pub struct Ping {}
