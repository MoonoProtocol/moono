use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use sha2::{Digest, Sha256};

use crate::errors::MoonoError;
use crate::instructions::FundLoanFill;
use crate::state::{AssetPool, ExecutionStrategyConfig, ProtocolConfig};

#[derive(AnchorSerialize)]
struct OpenLoanIxArgs {
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
}

#[derive(AnchorSerialize)]
struct InitializeBorrowSlicePositionIxArgs {
    loan_id: u64,
    tick: u32,
}

#[derive(AnchorSerialize)]
struct FundLoanFromTicksIxArgs {
    fills: Vec<FundLoanFill>,
}

#[derive(AnchorSerialize)]
struct ExecuteLaunchPumpFunIxArgs {
    use_create_v2: bool,
    name: String,
    symbol: String,
    uri: String,
    loan_quote_spend_amount: u64,
    extra_user_quote_spend_amount: u64,
    collateral_min_base_out: u64,
    immediate_user_min_base_out: u64,
}

fn anchor_discriminator(name: &str) -> [u8; 8] {
    let digest = Sha256::digest(format!("global:{name}").as_bytes());
    let mut discriminator = [0u8; 8];
    discriminator.copy_from_slice(&digest[..8]);
    discriminator
}

fn build_ix_data<T: AnchorSerialize>(name: &str, args: &T) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    data.extend_from_slice(&anchor_discriminator(name));
    args.serialize(&mut data)?;
    Ok(data)
}

#[allow(clippy::too_many_arguments)]
pub fn handle_open_fund_execute_launch_pump_fun<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenFundExecuteLaunchPumpFun<'info>>,
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
    fills: Vec<FundLoanFill>,
    use_create_v2: bool,
    name: String,
    symbol: String,
    uri: String,
    loan_quote_spend_amount: u64,
    extra_user_quote_spend_amount: u64,
    collateral_min_base_out: u64,
    immediate_user_min_base_out: u64,
) -> Result<()> {
    require!(
        fills.len() == planned_slice_count as usize,
        MoonoError::BorrowPlanSliceCountMismatch
    );

    let fund_remaining_count = fills
        .len()
        .checked_mul(2)
        .ok_or(error!(MoonoError::MathOverflow))?;
    require!(
        ctx.remaining_accounts.len() >= fund_remaining_count,
        MoonoError::InvalidRemainingAccounts
    );

    let open_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.protocol.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_asset_pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.strategy_config.key(), false),
            AccountMeta::new(ctx.accounts.owner.key(), true),
            AccountMeta::new(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new(ctx.accounts.user_quote_token_account.key(), false),
            AccountMeta::new(ctx.accounts.loan_position.key(), false),
            AccountMeta::new_readonly(ctx.accounts.loan_vault_authority.key(), false),
            AccountMeta::new(ctx.accounts.loan_quote_vault.key(), false),
            AccountMeta::new(ctx.accounts.loan_quote_buffer_vault.key(), false),
            AccountMeta::new_readonly(
                ctx.accounts.protocol_quote_treasury_authority.key(),
                false,
            ),
            AccountMeta::new(ctx.accounts.protocol_quote_treasury_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data: build_ix_data(
            "open_loan",
            &OpenLoanIxArgs {
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
            },
        )?,
    };
    invoke(
        &open_ix,
        &[
            ctx.accounts.self_program.to_account_info(),
            ctx.accounts.protocol.to_account_info(),
            ctx.accounts.quote_asset_pool.to_account_info(),
            ctx.accounts.strategy_config.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.user_quote_token_account.to_account_info(),
            ctx.accounts.loan_position.to_account_info(),
            ctx.accounts.loan_vault_authority.to_account_info(),
            ctx.accounts.loan_quote_vault.to_account_info(),
            ctx.accounts.loan_quote_buffer_vault.to_account_info(),
            ctx.accounts.protocol_quote_treasury_authority.to_account_info(),
            ctx.accounts.protocol_quote_treasury_vault.to_account_info(),
            ctx.accounts.quote_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    for (fill_index, fill) in fills.iter().enumerate() {
        let borrow_slice_info = ctx
            .remaining_accounts
            .get(fill_index * 2 + 1)
            .ok_or(error!(MoonoError::InvalidRemainingAccounts))?;
        let init_slice_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.protocol.key(), false),
                AccountMeta::new_readonly(ctx.accounts.quote_asset_pool.key(), false),
                AccountMeta::new(ctx.accounts.loan_position.key(), false),
                AccountMeta::new(ctx.accounts.owner.key(), true),
                AccountMeta::new(borrow_slice_info.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: build_ix_data(
                "initialize_borrow_slice_position",
                &InitializeBorrowSlicePositionIxArgs {
                    loan_id,
                    tick: fill.tick,
                },
            )?,
        };
        invoke(
            &init_slice_ix,
            &[
                ctx.accounts.self_program.to_account_info(),
                ctx.accounts.protocol.to_account_info(),
                ctx.accounts.quote_asset_pool.to_account_info(),
                ctx.accounts.loan_position.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                borrow_slice_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    let mut fund_accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.protocol.key(), false),
        AccountMeta::new(ctx.accounts.quote_asset_pool.key(), false),
        AccountMeta::new(ctx.accounts.owner.key(), true),
        AccountMeta::new(ctx.accounts.quote_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), false),
        AccountMeta::new(ctx.accounts.vault.key(), false),
        AccountMeta::new(ctx.accounts.loan_position.key(), false),
        AccountMeta::new(ctx.accounts.loan_quote_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_token_program.key(), false),
    ];
    let mut fund_infos = vec![
        ctx.accounts.protocol.to_account_info(),
        ctx.accounts.quote_asset_pool.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.loan_position.to_account_info(),
        ctx.accounts.loan_quote_vault.to_account_info(),
        ctx.accounts.quote_token_program.to_account_info(),
    ];
    for account in ctx.remaining_accounts.iter().take(fund_remaining_count) {
        fund_accounts.push(AccountMeta {
            pubkey: account.key(),
            is_signer: false,
            is_writable: account.is_writable,
        });
        fund_infos.push(account.clone());
    }
    let fund_ix = Instruction {
        program_id: crate::ID,
        accounts: fund_accounts,
        data: build_ix_data("fund_loan_from_ticks", &FundLoanFromTicksIxArgs { fills })?,
    };
    fund_infos.insert(0, ctx.accounts.self_program.to_account_info());
    invoke(&fund_ix, &fund_infos)?;

    let execute_remaining = &ctx.remaining_accounts[fund_remaining_count..];
    let mut execute_accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.protocol.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_asset_pool.key(), false),
        AccountMeta::new(ctx.accounts.owner.key(), true),
        AccountMeta::new(ctx.accounts.quote_mint.key(), false),
        AccountMeta::new(ctx.accounts.base_mint.key(), true),
        AccountMeta::new(ctx.accounts.loan_position.key(), false),
        AccountMeta::new_readonly(ctx.accounts.loan_vault_authority.key(), false),
        AccountMeta::new(ctx.accounts.loan_execution_wallet.key(), false),
        AccountMeta::new(ctx.accounts.loan_quote_vault.key(), false),
        AccountMeta::new(ctx.accounts.user_extra_quote_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_fun_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_fun_global.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_bonding_curve.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_associated_bonding_curve.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_loan_temporary_wsol_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_fun_mint_authority.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_fun_event_authority.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_fee_recipient.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_creator_vault.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_mayhem_program.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_global_params.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_sol_vault.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_mayhem_state.key(), false),
        AccountMeta::new(ctx.accounts.pump_fun_mayhem_token_vault.key(), false),
        AccountMeta::new(ctx.accounts.loan_collateral_vault.key(), false),
        AccountMeta::new(ctx.accounts.user_base_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.base_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
    ];
    let mut execute_infos = vec![
        ctx.accounts.protocol.to_account_info(),
        ctx.accounts.quote_asset_pool.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.base_mint.to_account_info(),
        ctx.accounts.loan_position.to_account_info(),
        ctx.accounts.loan_vault_authority.to_account_info(),
        ctx.accounts.loan_execution_wallet.to_account_info(),
        ctx.accounts.loan_quote_vault.to_account_info(),
        ctx.accounts.user_extra_quote_token_account.to_account_info(),
        ctx.accounts.pump_fun_program.to_account_info(),
        ctx.accounts.pump_fun_global.to_account_info(),
        ctx.accounts.pump_fun_bonding_curve.to_account_info(),
        ctx.accounts.pump_fun_associated_bonding_curve.to_account_info(),
        ctx.accounts.pump_fun_loan_temporary_wsol_vault.to_account_info(),
        ctx.accounts.pump_fun_mint_authority.to_account_info(),
        ctx.accounts.pump_fun_event_authority.to_account_info(),
        ctx.accounts.pump_fun_fee_recipient.to_account_info(),
        ctx.accounts.pump_fun_creator_vault.to_account_info(),
        ctx.accounts.pump_fun_mayhem_program.to_account_info(),
        ctx.accounts.pump_fun_global_params.to_account_info(),
        ctx.accounts.pump_fun_sol_vault.to_account_info(),
        ctx.accounts.pump_fun_mayhem_state.to_account_info(),
        ctx.accounts.pump_fun_mayhem_token_vault.to_account_info(),
        ctx.accounts.loan_collateral_vault.to_account_info(),
        ctx.accounts.user_base_token_account.to_account_info(),
        ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.base_token_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    ];
    for account in execute_remaining {
        execute_accounts.push(AccountMeta {
            pubkey: account.key(),
            is_signer: false,
            is_writable: account.is_writable,
        });
        execute_infos.push(account.clone());
    }
    let execute_ix = Instruction {
        program_id: crate::ID,
        accounts: execute_accounts,
        data: build_ix_data(
            "execute_launch_pump_fun",
            &ExecuteLaunchPumpFunIxArgs {
                use_create_v2,
                name,
                symbol,
                uri,
                loan_quote_spend_amount,
                extra_user_quote_spend_amount,
                collateral_min_base_out,
                immediate_user_min_base_out,
            },
        )?,
    };
    execute_infos.insert(0, ctx.accounts.self_program.to_account_info());
    invoke(&execute_ix, &execute_infos)?;

    Ok(())
}

#[derive(Accounts)]
pub struct OpenFundExecuteLaunchPumpFun<'info> {
    #[account(address = crate::ID)]
    /// CHECK: Current program account used for self-CPI orchestration.
    pub self_program: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump
    )]
    pub protocol: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"asset_pool", quote_asset_pool.mint.as_ref()],
        bump = quote_asset_pool.bump,
        constraint = quote_asset_pool.protocol == protocol.key()
    )]
    pub quote_asset_pool: Box<Account<'info, AssetPool>>,

    #[account(
        seeds = [b"strategy_config".as_ref(), &[strategy_config.mode]],
        bump = strategy_config.bump
    )]
    pub strategy_config: Box<Account<'info, ExecutionStrategyConfig>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub quote_mint: Box<InterfaceAccount<'info, anchor_spl::token_interface::Mint>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = quote_token_program
    )]
    pub user_quote_token_account:
        Box<InterfaceAccount<'info, anchor_spl::token_interface::TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = quote_token_program
    )]
    pub user_extra_quote_token_account:
        Box<InterfaceAccount<'info, anchor_spl::token_interface::TokenAccount>>,

    /// CHECK: Created by inner open_loan CPI
    #[account(mut)]
    pub loan_position: UncheckedAccount<'info>,

    /// CHECK: PDA validated by inner instructions
    pub loan_vault_authority: UncheckedAccount<'info>,

    /// CHECK: Created by inner open_loan CPI
    #[account(mut)]
    pub loan_quote_vault: UncheckedAccount<'info>,

    /// CHECK: Created by inner open_loan CPI
    #[account(mut)]
    pub loan_quote_buffer_vault: UncheckedAccount<'info>,

    /// CHECK: PDA validated by inner instructions
    pub protocol_quote_treasury_authority: UncheckedAccount<'info>,

    /// CHECK: Existing treasury vault validated by inner instructions
    #[account(mut)]
    pub protocol_quote_treasury_vault: UncheckedAccount<'info>,

    /// CHECK: PDA validated by inner instructions
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Existing asset pool vault validated by inner instructions
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub base_mint: Signer<'info>,

    /// CHECK: Created/initialized by inner execute CPI
    #[account(mut)]
    pub loan_execution_wallet: UncheckedAccount<'info>,

    /// CHECK: Generic executable adapter program account
    #[account(executable)]
    pub pump_fun_program: UncheckedAccount<'info>,

    /// CHECK: Pump.fun global account
    pub pump_fun_global: UncheckedAccount<'info>,

    /// CHECK: Pump.fun bonding curve PDA for this mint
    #[account(mut)]
    pub pump_fun_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Pump.fun associated bonding curve token account
    #[account(mut)]
    pub pump_fun_associated_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Temporary WSOL vault for loan-funded buy path
    #[account(mut)]
    pub pump_fun_loan_temporary_wsol_vault: UncheckedAccount<'info>,

    /// CHECK: Fixed pump.fun mint authority PDA
    pub pump_fun_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Pump.fun event authority
    pub pump_fun_event_authority: UncheckedAccount<'info>,

    /// CHECK: Writable fee recipient
    #[account(mut)]
    pub pump_fun_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: Writable creator vault
    #[account(mut)]
    pub pump_fun_creator_vault: UncheckedAccount<'info>,

    /// CHECK: Pump.fun create_v2 mayhem program
    #[account(mut)]
    pub pump_fun_mayhem_program: UncheckedAccount<'info>,

    /// CHECK: Pump.fun create_v2 global params
    #[account(mut)]
    pub pump_fun_global_params: UncheckedAccount<'info>,

    /// CHECK: Pump.fun create_v2 sol vault
    #[account(mut)]
    pub pump_fun_sol_vault: UncheckedAccount<'info>,

    /// CHECK: Pump.fun create_v2 mayhem state
    #[account(mut)]
    pub pump_fun_mayhem_state: UncheckedAccount<'info>,

    /// CHECK: Pump.fun create_v2 mayhem token vault
    #[account(mut)]
    pub pump_fun_mayhem_token_vault: UncheckedAccount<'info>,

    /// CHECK: Created/initialized by inner execute CPI
    #[account(mut)]
    pub loan_collateral_vault: UncheckedAccount<'info>,

    /// CHECK: Created/initialized by inner execute CPI
    #[account(mut)]
    pub user_base_token_account: UncheckedAccount<'info>,

    pub quote_token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
    pub base_token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
    /// CHECK: Associated token program used in inner execute CPI
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
