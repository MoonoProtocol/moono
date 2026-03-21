use anchor_lang::prelude::*;

use crate::errors::MoonoError;
use crate::state::{ExecutionStrategyConfig, ProtocolConfig};

pub fn handle_initialize_execution_strategy_config(
    ctx: Context<InitializeExecutionStrategyConfig>,
    mode: u8,
    extra_quote_collateral_bps: u16,
    max_quote_loss_bps: u16,
    min_quote_buffer_amount: u64,
    fixed_migration_cost_quote: u64,
) -> Result<()> {
    let strategy_config = &mut ctx.accounts.strategy_config;

    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        MoonoError::Unauthorized
    );

    strategy_config.version = 1;
    strategy_config.bump = ctx.bumps.strategy_config;
    strategy_config.mode = mode;
    strategy_config.is_enabled = true;
    strategy_config.extra_quote_collateral_bps = extra_quote_collateral_bps;
    strategy_config.max_quote_loss_bps = max_quote_loss_bps;
    strategy_config.min_quote_buffer_amount = min_quote_buffer_amount;
    strategy_config.fixed_migration_cost_quote = fixed_migration_cost_quote;
    strategy_config.reserved = [0; 32];

    msg!("Execution strategy config initialized");
    Ok(())
}

#[derive(Accounts)]
#[instruction(mode: u8)]
pub struct InitializeExecutionStrategyConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = authority
    )]
    pub protocol: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        seeds = [b"strategy_config".as_ref(), &[mode]],
        bump,
        space = 8 + ExecutionStrategyConfig::INIT_SPACE
    )]
    pub strategy_config: Account<'info, ExecutionStrategyConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}