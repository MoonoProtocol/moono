use anchor_lang::prelude::*;

use crate::errors::MoonoError;
use crate::state::{ExecutionStrategyConfig, ProtocolConfig};

pub fn handle_set_execution_strategy_config(
    ctx: Context<SetExecutionStrategyConfig>,
    is_enabled: bool,
    extra_quote_collateral_bps: u16,
    max_quote_loss_bps: u16,
    min_quote_buffer_amount: u64,
    fixed_migration_cost_quote: u64,
) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let strategy_config = &mut ctx.accounts.strategy_config;

    require!(
        protocol.authority == ctx.accounts.authority.key(),
        MoonoError::Unauthorized
    );

    strategy_config.is_enabled = is_enabled;
    strategy_config.extra_quote_collateral_bps = extra_quote_collateral_bps;
    strategy_config.max_quote_loss_bps = max_quote_loss_bps;
    strategy_config.min_quote_buffer_amount = min_quote_buffer_amount;
    strategy_config.fixed_migration_cost_quote = fixed_migration_cost_quote;

    msg!("Execution strategy config updated");
    Ok(())
}

#[derive(Accounts)]
pub struct SetExecutionStrategyConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = authority
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"strategy_config".as_ref(), &[strategy_config.mode]],
        bump = strategy_config.bump
    )]
    pub strategy_config: Account<'info, ExecutionStrategyConfig>,

    pub authority: Signer<'info>,
}
