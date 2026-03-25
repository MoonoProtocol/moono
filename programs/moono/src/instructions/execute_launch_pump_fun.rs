use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use sha2::{Digest, Sha256};
use spl_token::native_mint::ID as WSOL_MINT;
use spl_token::state::{Account as SplTokenAccount, Mint as SplMint};
use spl_token::solana_program::program_pack::Pack;
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};

use crate::errors::MoonoError;
use crate::state::{
    AssetPool, LoanPosition, ProtocolConfig, LOAN_STATUS_EXECUTED, LOAN_STATUS_FUNDED,
    MODE_PUMP_FUN,
};

#[derive(AnchorSerialize)]
struct PumpFunCreateIxArgs {
    name: String,
    symbol: String,
    uri: String,
}

#[derive(AnchorSerialize)]
struct PumpFunBuyExactSolInIxArgs {
    quote_spend_amount: u64,
    min_base_output_amount: u64,
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

fn ensure_base_mint_initialized(ctx: &Context<ExecuteLaunchPumpFun>) -> Result<()> {
    if !ctx.accounts.base_mint.data_is_empty() {
        return Ok(());
    }

    let rent = Rent::get()?;
    let mint_space = SplMint::LEN as u64;
    let mint_lamports = rent.minimum_balance(SplMint::LEN);

    invoke(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.owner.key(),
            &ctx.accounts.base_mint.key(),
            mint_lamports,
            mint_space,
            &ctx.accounts.token_program.key(),
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    invoke(
        &spl_token::instruction::initialize_mint2(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.base_mint.key(),
            &ctx.accounts.pump_fun_mint_authority.key(),
            None,
            6,
        )?,
        &[
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn ensure_execution_wallet_initialized(ctx: &Context<ExecuteLaunchPumpFun>) -> Result<()> {
    if !ctx.accounts.loan_execution_wallet.data_is_empty() {
        return Ok(());
    }

    let loan_position_key = ctx.accounts.loan_position.key();
    let execution_wallet_bump = ctx.bumps.loan_execution_wallet;
    let execution_wallet_bump_seed = [execution_wallet_bump];
    let execution_wallet_signer_seeds: &[&[u8]] = &[
        b"loan_execution_wallet",
        loan_position_key.as_ref(),
        &execution_wallet_bump_seed,
    ];
    let execution_wallet_signer: &[&[&[u8]]] = &[execution_wallet_signer_seeds];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.owner.key(),
            &ctx.accounts.loan_execution_wallet.key(),
            Rent::get()?.minimum_balance(0).saturating_add(5_000_000),
            0,
            &anchor_lang::solana_program::system_program::ID,
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.loan_execution_wallet.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        execution_wallet_signer,
    )?;

    Ok(())
}

fn ensure_collateral_vault_initialized(ctx: &Context<ExecuteLaunchPumpFun>) -> Result<()> {
    let expected_ata = get_associated_token_address_with_program_id(
        &ctx.accounts.loan_execution_wallet.key(),
        &ctx.accounts.base_mint.key(),
        &ctx.accounts.token_program.key(),
    );
    require!(
        ctx.accounts.loan_collateral_vault.key() == expected_ata,
        MoonoError::InvalidTokenAccount
    );

    if !ctx.accounts.loan_collateral_vault.data_is_empty() {
        return Ok(());
    }

    invoke(
        &create_associated_token_account_idempotent(
            &ctx.accounts.owner.key(),
            &ctx.accounts.loan_execution_wallet.key(),
            &ctx.accounts.base_mint.key(),
            &ctx.accounts.token_program.key(),
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.loan_collateral_vault.to_account_info(),
            ctx.accounts.loan_execution_wallet.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn ensure_user_base_token_account_initialized(ctx: &Context<ExecuteLaunchPumpFun>) -> Result<()> {
    let expected_ata = get_associated_token_address_with_program_id(
        &ctx.accounts.owner.key(),
        &ctx.accounts.base_mint.key(),
        &ctx.accounts.token_program.key(),
    );
    require!(
        ctx.accounts.user_base_token_account.key() == expected_ata,
        MoonoError::InvalidTokenAccount
    );

    if !ctx.accounts.user_base_token_account.data_is_empty() {
        return Ok(());
    }

    invoke(
        &create_associated_token_account_idempotent(
            &ctx.accounts.owner.key(),
            &ctx.accounts.owner.key(),
            &ctx.accounts.base_mint.key(),
            &ctx.accounts.token_program.key(),
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.user_base_token_account.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn ensure_pump_fun_associated_bonding_curve_initialized(
    ctx: &Context<ExecuteLaunchPumpFun>,
) -> Result<()> {
    let expected_ata = get_associated_token_address_with_program_id(
        &ctx.accounts.pump_fun_bonding_curve.key(),
        &ctx.accounts.base_mint.key(),
        &ctx.accounts.token_program.key(),
    );
    require!(
        ctx.accounts.pump_fun_associated_bonding_curve.key() == expected_ata,
        MoonoError::InvalidTokenAccount
    );

    if !ctx.accounts.pump_fun_associated_bonding_curve.data_is_empty() {
        return Ok(());
    }

    invoke(
        &create_associated_token_account_idempotent(
            &ctx.accounts.owner.key(),
            &ctx.accounts.pump_fun_bonding_curve.key(),
            &ctx.accounts.base_mint.key(),
            &ctx.accounts.token_program.key(),
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.pump_fun_associated_bonding_curve.to_account_info(),
            ctx.accounts.pump_fun_bonding_curve.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn read_token_account(account_info: &AccountInfo) -> Result<SplTokenAccount> {
    let data = account_info.try_borrow_data()?;
    SplTokenAccount::unpack(&data).map_err(Into::into)
}

fn ensure_temp_wsol_vault_initialized<'info>(
    payer: &Signer<'info>,
    quote_mint: &InterfaceAccount<'info, Mint>,
    temp_wsol_vault: &UncheckedAccount<'info>,
    temp_wsol_vault_signers: &[&[&[u8]]],
    quote_sink_authority: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    if !temp_wsol_vault.data_is_empty() {
        return Ok(());
    }

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &payer.key(),
            &temp_wsol_vault.key(),
            Rent::get()?.minimum_balance(SplTokenAccount::LEN),
            SplTokenAccount::LEN as u64,
            &token_program.key(),
        ),
        &[
            payer.to_account_info(),
            temp_wsol_vault.to_account_info(),
            system_program.to_account_info(),
        ],
        temp_wsol_vault_signers,
    )?;

    invoke(
        &spl_token::instruction::initialize_account3(
            &token_program.key(),
            &temp_wsol_vault.key(),
            &quote_mint.key(),
            &quote_sink_authority.key(),
        )?,
        &[
            temp_wsol_vault.to_account_info(),
            quote_mint.to_account_info(),
            quote_sink_authority.to_account_info(),
            token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn unwrap_wsol_to_lamports<'info>(
    payer: &Signer<'info>,
    quote_mint: &InterfaceAccount<'info, Mint>,
    source_token_account: &InterfaceAccount<'info, TokenAccount>,
    source_authority: &AccountInfo<'info>,
    source_authority_signers: &[&[&[u8]]],
    quote_sink_authority: &UncheckedAccount<'info>,
    quote_sink_authority_signers: &[&[&[u8]]],
    temp_wsol_vault: &UncheckedAccount<'info>,
    temp_wsol_vault_signers: &[&[&[u8]]],
    lamport_destination: &AccountInfo<'info>,
    amount: u64,
    token_program: &Interface<'info, TokenInterface>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    ensure_temp_wsol_vault_initialized(
        payer,
        quote_mint,
        temp_wsol_vault,
        temp_wsol_vault_signers,
        quote_sink_authority,
        token_program,
        system_program,
    )?;

    transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: source_token_account.to_account_info(),
                mint: quote_mint.to_account_info(),
                to: temp_wsol_vault.to_account_info(),
                authority: source_authority.clone(),
            },
            source_authority_signers,
        ),
        amount,
        quote_mint.decimals,
    )?;

    invoke_signed(
        &spl_token::instruction::close_account(
            &token_program.key(),
            &temp_wsol_vault.key(),
            lamport_destination.key,
            &quote_sink_authority.key(),
            &[],
        )?,
        &[
            temp_wsol_vault.to_account_info(),
            lamport_destination.clone(),
            quote_sink_authority.to_account_info(),
            token_program.to_account_info(),
        ],
        quote_sink_authority_signers,
    )?;

    Ok(())
}

pub fn handle_execute_launch_pump_fun(
    ctx: Context<ExecuteLaunchPumpFun>,
    use_create_v2: bool,
    name: String,
    symbol: String,
    uri: String,
    loan_quote_spend_amount: u64,
    extra_user_quote_spend_amount: u64,
    collateral_min_base_out: u64,
    immediate_user_min_base_out: u64,
) -> Result<()> {
    require!(loan_quote_spend_amount > 0, MoonoError::InvalidAmount);
    require!(
        extra_user_quote_spend_amount > 0 || immediate_user_min_base_out == 0,
        MoonoError::InvalidAmount
    );

    let protocol = &ctx.accounts.protocol;
    let loan_position = &ctx.accounts.loan_position;

    require!(!protocol.paused, MoonoError::ProtocolPaused);
    require!(loan_position.owner == ctx.accounts.owner.key(), MoonoError::Unauthorized);
    require!(
        loan_position.quote_asset_pool == ctx.accounts.quote_asset_pool.key(),
        MoonoError::InvalidLoanPosition
    );
    require!(
        loan_position.strategy_mode == MODE_PUMP_FUN,
        MoonoError::WrongStrategyMode
    );
    require!(
        loan_position.status == LOAN_STATUS_FUNDED,
        MoonoError::InvalidLoanStatus
    );
    require!(
        loan_position.loan_quote_vault == ctx.accounts.loan_quote_vault.key(),
        MoonoError::InvalidLoanPosition
    );
    require!(
        ctx.accounts.loan_quote_vault.mint == ctx.accounts.quote_mint.key(),
        MoonoError::WrongMint
    );
    require!(
        ctx.accounts.quote_mint.key() == WSOL_MINT &&
        ctx.accounts.quote_asset_pool.mint == WSOL_MINT,
        MoonoError::PumpFunRequiresWsolQuote
    );
    require!(
        ctx.accounts.user_extra_quote_token_account.mint == ctx.accounts.quote_mint.key(),
        MoonoError::WrongMint
    );
    require!(
        extra_user_quote_spend_amount <= loan_position.extra_user_quote_amount,
        MoonoError::ExtraUserQuoteAmountExceeded
    );

    ensure_base_mint_initialized(&ctx)?;
    ensure_execution_wallet_initialized(&ctx)?;
    ensure_pump_fun_associated_bonding_curve_initialized(&ctx)?;
    ensure_collateral_vault_initialized(&ctx)?;
    ensure_user_base_token_account_initialized(&ctx)?;

    let collateral_before_account = read_token_account(&ctx.accounts.loan_collateral_vault)?;
    let user_base_before_account = read_token_account(&ctx.accounts.user_base_token_account)?;
    require!(
        collateral_before_account.mint == ctx.accounts.base_mint.key(),
        MoonoError::WrongMint
    );
    require!(
        collateral_before_account.owner == ctx.accounts.loan_execution_wallet.key(),
        MoonoError::InvalidTokenAccount
    );
    require!(
        user_base_before_account.mint == ctx.accounts.base_mint.key(),
        MoonoError::WrongMint
    );
    require!(
        user_base_before_account.owner == ctx.accounts.owner.key(),
        MoonoError::InvalidTokenAccount
    );
    let collateral_before = collateral_before_account.amount;
    let user_base_before = user_base_before_account.amount;

    let loan_position_key = loan_position.key();
    let loan_execution_wallet_bump = ctx.bumps.loan_execution_wallet;
    let loan_execution_wallet_bump_seed = [loan_execution_wallet_bump];
    let loan_execution_wallet_signer_seeds: &[&[u8]] = &[
        b"loan_execution_wallet",
        loan_position_key.as_ref(),
        &loan_execution_wallet_bump_seed,
    ];
    let loan_vault_authority_bump = ctx.bumps.loan_vault_authority;
    let loan_vault_authority_bump_seed = [loan_vault_authority_bump];
    let loan_vault_authority_signer_seeds: &[&[u8]] = &[
        b"loan_vault_authority",
        loan_position_key.as_ref(),
        &loan_vault_authority_bump_seed,
    ];
    let quote_sink_authority_bump = ctx.bumps.pump_fun_quote_sink_authority;
    let quote_sink_authority_bump_seed = [quote_sink_authority_bump];
    let quote_sink_authority_signer_seeds: &[&[u8]] = &[
        b"quote_sink_authority",
        loan_position_key.as_ref(),
        &quote_sink_authority_bump_seed,
    ];
    let quote_sink_authority_signers: &[&[&[u8]]] = &[quote_sink_authority_signer_seeds];
    let loan_temp_wsol_bump = ctx.bumps.pump_fun_loan_temporary_wsol_vault;
    let loan_temp_wsol_bump_seed = [loan_temp_wsol_bump];
    let loan_temp_wsol_signer_seeds: &[&[u8]] = &[
        b"temp_wsol_vault",
        loan_position_key.as_ref(),
        b"loan",
        &loan_temp_wsol_bump_seed,
    ];
    let loan_temp_wsol_signers: &[&[&[u8]]] = &[loan_temp_wsol_signer_seeds];
    let user_temp_wsol_bump = ctx.bumps.pump_fun_user_temporary_wsol_vault;
    let user_temp_wsol_bump_seed = [user_temp_wsol_bump];
    let user_temp_wsol_signer_seeds: &[&[u8]] = &[
        b"temp_wsol_vault",
        loan_position_key.as_ref(),
        b"user",
        &user_temp_wsol_bump_seed,
    ];
    let user_temp_wsol_signers: &[&[&[u8]]] = &[user_temp_wsol_signer_seeds];
    let borrowed_buy_signers: &[&[&[u8]]] = &[
        loan_execution_wallet_signer_seeds,
        loan_vault_authority_signer_seeds,
    ];

    unwrap_wsol_to_lamports(
        &ctx.accounts.owner,
        &ctx.accounts.quote_mint,
        &ctx.accounts.loan_quote_vault,
        &ctx.accounts.loan_vault_authority.to_account_info(),
        &[loan_vault_authority_signer_seeds],
        &ctx.accounts.pump_fun_quote_sink_authority,
        quote_sink_authority_signers,
        &ctx.accounts.pump_fun_loan_temporary_wsol_vault,
        loan_temp_wsol_signers,
        &ctx.accounts.loan_execution_wallet.to_account_info(),
        loan_quote_spend_amount,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
    )?;

    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.pump_fun_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.base_mint.key(), true),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_mint_authority.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_bonding_curve.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_associated_bonding_curve.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_global.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_mpl_token_metadata.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_metadata.key(), false),
                AccountMeta::new(ctx.accounts.owner.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_program.key(), false),
            ],
            data: build_ix_data(
                if use_create_v2 { "create_v2" } else { "create" },
                &PumpFunCreateIxArgs { name, symbol, uri },
            )?,
        },
        &[
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.pump_fun_mint_authority.to_account_info(),
            ctx.accounts.pump_fun_bonding_curve.to_account_info(),
            ctx.accounts.pump_fun_associated_bonding_curve.to_account_info(),
            ctx.accounts.pump_fun_global.to_account_info(),
            ctx.accounts.pump_fun_mpl_token_metadata.to_account_info(),
            ctx.accounts.pump_fun_metadata.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.pump_fun_event_authority.to_account_info(),
            ctx.accounts.pump_fun_program.to_account_info(),
        ],
        &[],
    )?;

    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.pump_fun_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.pump_fun_global.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_fee_recipient.key(), false),
                AccountMeta::new(ctx.accounts.base_mint.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_bonding_curve.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_associated_bonding_curve.key(), false),
                AccountMeta::new(ctx.accounts.loan_collateral_vault.key(), false),
                AccountMeta::new(ctx.accounts.loan_execution_wallet.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new(ctx.accounts.pump_fun_creator_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.pump_fun_program.key(), false),
            ],
            data: build_ix_data(
                "buy_exact_sol_in",
                &PumpFunBuyExactSolInIxArgs {
                    quote_spend_amount: loan_quote_spend_amount,
                    min_base_output_amount: collateral_min_base_out,
                },
            )?,
        },
        &[
            ctx.accounts.pump_fun_global.to_account_info(),
            ctx.accounts.pump_fun_fee_recipient.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.pump_fun_bonding_curve.to_account_info(),
            ctx.accounts.pump_fun_associated_bonding_curve.to_account_info(),
            ctx.accounts.loan_collateral_vault.to_account_info(),
            ctx.accounts.loan_execution_wallet.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.pump_fun_creator_vault.to_account_info(),
            ctx.accounts.pump_fun_event_authority.to_account_info(),
            ctx.accounts.pump_fun_program.to_account_info(),
        ],
        borrowed_buy_signers,
    )?;

    if extra_user_quote_spend_amount > 0 {
        unwrap_wsol_to_lamports(
            &ctx.accounts.owner,
            &ctx.accounts.quote_mint,
            &ctx.accounts.user_extra_quote_token_account,
            &ctx.accounts.owner.to_account_info(),
            &[],
            &ctx.accounts.pump_fun_quote_sink_authority,
            quote_sink_authority_signers,
            &ctx.accounts.pump_fun_user_temporary_wsol_vault,
            user_temp_wsol_signers,
            &ctx.accounts.owner.to_account_info(),
            extra_user_quote_spend_amount,
            &ctx.accounts.token_program,
            &ctx.accounts.system_program,
        )?;

        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.pump_fun_program.key(),
                accounts: vec![
                    AccountMeta::new_readonly(ctx.accounts.pump_fun_global.key(), false),
                    AccountMeta::new(ctx.accounts.pump_fun_fee_recipient.key(), false),
                    AccountMeta::new(ctx.accounts.base_mint.key(), false),
                    AccountMeta::new(ctx.accounts.pump_fun_bonding_curve.key(), false),
                    AccountMeta::new(ctx.accounts.pump_fun_associated_bonding_curve.key(), false),
                    AccountMeta::new(ctx.accounts.user_base_token_account.key(), false),
                    AccountMeta::new(ctx.accounts.owner.key(), true),
                    AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                    AccountMeta::new(ctx.accounts.pump_fun_creator_vault.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.pump_fun_event_authority.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.pump_fun_program.key(), false),
                ],
                data: build_ix_data(
                    "buy_exact_sol_in",
                    &PumpFunBuyExactSolInIxArgs {
                        quote_spend_amount: extra_user_quote_spend_amount,
                        min_base_output_amount: immediate_user_min_base_out,
                    },
                )?,
            },
            &[
                ctx.accounts.pump_fun_global.to_account_info(),
                ctx.accounts.pump_fun_fee_recipient.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.pump_fun_bonding_curve.to_account_info(),
                ctx.accounts.pump_fun_associated_bonding_curve.to_account_info(),
                ctx.accounts.user_base_token_account.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.pump_fun_creator_vault.to_account_info(),
                ctx.accounts.pump_fun_event_authority.to_account_info(),
                ctx.accounts.pump_fun_program.to_account_info(),
            ],
            &[],
        )?;
    }

    let collateral_after = read_token_account(&ctx.accounts.loan_collateral_vault)?.amount;
    let user_base_after = read_token_account(&ctx.accounts.user_base_token_account)?.amount;

    let collateral_amount = collateral_after
        .checked_sub(collateral_before)
        .ok_or(error!(MoonoError::InvariantViolation))?;
    let immediate_user_base_amount = user_base_after
        .checked_sub(user_base_before)
        .ok_or(error!(MoonoError::InvariantViolation))?;
    let total_base_amount = collateral_amount
        .checked_add(immediate_user_base_amount)
        .ok_or(error!(MoonoError::MathOverflow))?;

    let now_ts = Clock::get()?.unix_timestamp;
    let loan_position = &mut ctx.accounts.loan_position;

    loan_position.executed_at = now_ts;
    loan_position.executed_loan_quote_amount = loan_quote_spend_amount;
    loan_position.executed_extra_user_quote_amount = extra_user_quote_spend_amount;
    loan_position.executed_total_base_amount = total_base_amount;
    loan_position.collateral_mint = ctx.accounts.base_mint.key();
    loan_position.collateral_vault = ctx.accounts.loan_collateral_vault.key();
    loan_position.collateral_amount = collateral_amount;
    loan_position.immediate_user_base_amount = immediate_user_base_amount;
    loan_position.status = LOAN_STATUS_EXECUTED;

    msg!("Pump.fun launch executed via create/create_v2 + buy_exact_sol_in adapter CPI");
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteLaunchPumpFun<'info> {
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

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub base_mint: Signer<'info>,

    #[account(
        mut,
        constraint = loan_position.owner == owner.key(),
        constraint = loan_position.quote_asset_pool == quote_asset_pool.key(),
        constraint = loan_position.loan_quote_vault == loan_quote_vault.key()
    )]
    pub loan_position: Box<Account<'info, LoanPosition>>,

    /// CHECK: PDA authority for loan-owned vaults, no data is read or written directly
    #[account(
        seeds = [b"loan_vault_authority", loan_position.key().as_ref()],
        bump
    )]
    pub loan_vault_authority: UncheckedAccount<'info>,

    /// CHECK: System-account PDA that will become the real buyer/custody wallet for borrowed pump.fun buys
    #[account(
        mut,
        seeds = [b"loan_execution_wallet", loan_position.key().as_ref()],
        bump
    )]
    pub loan_execution_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"loan_quote_vault", loan_position.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub loan_quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_program
    )]
    pub user_extra_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Generic executable adapter program account. `moono` validates only
    /// that the account is executable and relies on ABI compatibility at runtime.
    #[account(executable)]
    pub pump_fun_program: UncheckedAccount<'info>,

    /// CHECK: Internal PDA authority used by `moono` for temporary WSOL bridge vaults.
    #[account(
        seeds = [b"quote_sink_authority", loan_position.key().as_ref()],
        bump
    )]
    pub pump_fun_quote_sink_authority: UncheckedAccount<'info>,

    /// CHECK: Pump.fun global account / placeholder in tests.
    pub pump_fun_global: UncheckedAccount<'info>,

    /// CHECK: Pump.fun bonding curve PDA for this mint.
    #[account(mut)]
    pub pump_fun_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Pump.fun associated bonding curve token account.
    #[account(mut)]
    pub pump_fun_associated_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Metaplex token metadata program.
    pub pump_fun_mpl_token_metadata: UncheckedAccount<'info>,

    /// CHECK: Metadata account passed to create/create_v2.
    #[account(mut)]
    pub pump_fun_metadata: UncheckedAccount<'info>,

    /// CHECK: Temporary WSOL vault for the loan-funded buy path
    #[account(
        mut,
        seeds = [b"temp_wsol_vault", loan_position.key().as_ref(), b"loan"],
        bump
    )]
    pub pump_fun_loan_temporary_wsol_vault: UncheckedAccount<'info>,

    /// CHECK: Temporary WSOL vault for the user-funded buy path
    #[account(
        mut,
        seeds = [b"temp_wsol_vault", loan_position.key().as_ref(), b"user"],
        bump
    )]
    pub pump_fun_user_temporary_wsol_vault: UncheckedAccount<'info>,

    /// CHECK: Fixed mint authority PDA expected by the pump.fun-compatible program
    pub pump_fun_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Pump.fun event authority placeholder.
    pub pump_fun_event_authority: UncheckedAccount<'info>,

    /// CHECK: Writable fee recipient placeholder matching pump.fun buy layout.
    #[account(mut)]
    pub pump_fun_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: Writable creator vault placeholder matching pump.fun buy layout.
    #[account(mut)]
    pub pump_fun_creator_vault: UncheckedAccount<'info>,

    /// CHECK: Must be the ATA of `loan_execution_wallet` for `base_mint`
    #[account(mut)]
    pub loan_collateral_vault: UncheckedAccount<'info>,

    /// CHECK: Must be the owner's ATA for the freshly created base mint
    #[account(mut)]
    pub user_base_token_account: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Associated token program used both for ATA creation and create/create_v2 CPI layout.
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: Rent sysvar required by pump.fun create/create_v2 layout.
    pub rent: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
