use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token_interface::{
    mint_to, transfer_checked, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::state::Mint as SplMint2022;

declare_id!("pump5khDuXvghyrSQATnojua6ydquBG5fN7FibwHF4e");

const QUOTE_TO_BASE_DIVISOR: u64 = 10_000;
const INITIAL_CURVE_LIQUIDITY: u64 = 1_000_000_000_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum OptionBool {
    None,
    Some(bool),
}

#[account]
#[derive(InitSpace)]
pub struct LaunchState {
    pub bump: u8,
    pub version: u8,
    pub _padding: [u8; 6],
    pub owner: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    #[max_len(64)]
    pub name: String,
    #[max_len(16)]
    pub symbol: String,
    #[max_len(256)]
    pub uri: String,
}

#[program]
pub mod mock_pump_fun {
    use super::*;

    pub fn create(
        ctx: Context<Create>,
        name: String,
        symbol: String,
        uri: String,
        creator: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.base_mint.mint_authority
                == COption::Some(ctx.accounts.pump_fun_mint_authority.key()),
            MockPumpFunError::WrongMintAuthority
        );
        mint_initial_curve_liquidity(
            &ctx.accounts.base_mint,
            &ctx.accounts.associated_bonding_curve,
            &ctx.accounts.pump_fun_mint_authority,
            &ctx.accounts.token_program,
        )?;
        write_launch_state(
            &mut ctx.accounts.metadata,
            ctx.bumps.metadata,
            1,
            ctx.accounts.owner.key(),
            creator,
            ctx.accounts.base_mint.key(),
            name,
            symbol,
            uri,
        )
    }

    pub fn create_v2(
        ctx: Context<CreateV2>,
        name: String,
        symbol: String,
        uri: String,
        creator: Pubkey,
        _is_mayhem_mode: bool,
        _is_cashback_enabled: OptionBool,
    ) -> Result<()> {
        if ctx.accounts.base_mint.data_is_empty() {
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    &ctx.accounts.owner.key(),
                    &ctx.accounts.base_mint.key(),
                    Rent::get()?.minimum_balance(SplMint2022::LEN),
                    SplMint2022::LEN as u64,
                    &ctx.accounts.token_program.key(),
                ),
                &[
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[],
            )?;

            invoke_signed(
                &spl_token_2022::instruction::initialize_mint2(
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
                &[],
            )?;
        }

        if ctx.accounts.associated_bonding_curve.data_is_empty() {
            anchor_lang::solana_program::program::invoke(
                &create_associated_token_account_idempotent(
                    &ctx.accounts.owner.key(),
                    &ctx.accounts.bonding_curve.key(),
                    &ctx.accounts.base_mint.key(),
                    &ctx.accounts.token_program.key(),
                ),
                &[
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.associated_bonding_curve.to_account_info(),
                    ctx.accounts.bonding_curve.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.associated_token_program.to_account_info(),
                ],
            )?;
        }
        mint_initial_curve_liquidity_unchecked(
            &ctx.accounts.base_mint.to_account_info(),
            &ctx.accounts.associated_bonding_curve,
            &ctx.accounts.pump_fun_mint_authority,
            &ctx.accounts.token_program,
        )?;
        write_launch_state(
            &mut ctx.accounts.mayhem_state,
            ctx.bumps.mayhem_state,
            2,
            ctx.accounts.owner.key(),
            creator,
            ctx.accounts.base_mint.key(),
            name,
            symbol,
            uri,
        )
    }

    pub fn buy_exact_sol_in(
        ctx: Context<BuyExactSolIn>,
        quote_spend_amount: u64,
        min_base_output_amount: u64,
        _track_volume: u8,
    ) -> Result<()> {
        require!(quote_spend_amount > 0, MockPumpFunError::InvalidAmount);

        let base_output_amount = quote_spend_amount
            .checked_div(QUOTE_TO_BASE_DIVISOR)
            .ok_or(error!(MockPumpFunError::MathOverflow))?;
        require!(base_output_amount > 0, MockPumpFunError::InvalidAmount);
        require!(
            base_output_amount >= min_base_output_amount,
            MockPumpFunError::SlippageExceeded
        );

        require!(
            ctx.accounts.associated_user.mint == ctx.accounts.base_mint.key(),
            MockPumpFunError::WrongMint
        );

        let (_bonding_curve, bonding_curve_bump) = Pubkey::find_program_address(
            &[b"bonding-curve", ctx.accounts.base_mint.key().as_ref()],
            ctx.program_id,
        );
        let bonding_curve_bump_seed = [bonding_curve_bump];
        let base_mint_key = ctx.accounts.base_mint.key();
        let bonding_curve_signer_seeds: &[&[u8]] = &[
            b"bonding-curve",
            base_mint_key.as_ref(),
            &bonding_curve_bump_seed,
        ];
        let bonding_curve_signer: &[&[&[u8]]] = &[bonding_curve_signer_seeds];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.associated_bonding_curve.to_account_info(),
            mint: ctx.accounts.base_mint.to_account_info(),
            to: ctx.accounts.associated_user.to_account_info(),
            authority: ctx.accounts.bonding_curve.to_account_info(),
        };

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                bonding_curve_signer,
            ),
            base_output_amount,
            ctx.accounts.base_mint.decimals,
        )?;

        Ok(())
    }
}

fn mint_initial_curve_liquidity_unchecked<'info>(
    base_mint: &AccountInfo<'info>,
    associated_bonding_curve: &UncheckedAccount<'info>,
    pump_fun_mint_authority: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let (_pump_fun_mint_authority, pump_fun_mint_authority_bump) =
        Pubkey::find_program_address(&[b"mint-authority"], &crate::ID);
    let pump_fun_mint_authority_bump_seed = [pump_fun_mint_authority_bump];
    let pump_fun_mint_authority_signer_seeds: &[&[u8]] =
        &[b"mint-authority", &pump_fun_mint_authority_bump_seed];
    let pump_fun_mint_authority_signer: &[&[&[u8]]] =
        &[pump_fun_mint_authority_signer_seeds];

    invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_program.key(),
            base_mint.key,
            &associated_bonding_curve.key(),
            &pump_fun_mint_authority.key(),
            &[],
            INITIAL_CURVE_LIQUIDITY,
        )?,
        &[
            base_mint.clone(),
            associated_bonding_curve.to_account_info(),
            pump_fun_mint_authority.to_account_info(),
            token_program.to_account_info(),
        ],
        pump_fun_mint_authority_signer,
    )?;

    Ok(())
}

fn write_launch_state<'info>(
    launch_state: &mut Account<'info, LaunchState>,
    launch_state_bump: u8,
    version: u8,
    owner: Pubkey,
    creator: Pubkey,
    mint: Pubkey,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(name.len() <= 64, MockPumpFunError::LaunchMetadataTooLong);
    require!(symbol.len() <= 16, MockPumpFunError::LaunchMetadataTooLong);
    require!(uri.len() <= 256, MockPumpFunError::LaunchMetadataTooLong);

    launch_state.bump = launch_state_bump;
    launch_state.version = version;
    launch_state.owner = owner;
    launch_state.creator = creator;
    launch_state.mint = mint;
    launch_state.name = name;
    launch_state.symbol = symbol;
    launch_state.uri = uri;

    Ok(())
}

fn mint_initial_curve_liquidity<'info>(
    base_mint: &InterfaceAccount<'info, Mint>,
    associated_bonding_curve: &UncheckedAccount<'info>,
    pump_fun_mint_authority: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let current_supply = base_mint.supply;
    if current_supply > 0 {
        return Ok(());
    }

    let (_pump_fun_mint_authority, pump_fun_mint_authority_bump) =
        Pubkey::find_program_address(&[b"mint-authority"], &crate::ID);
    let pump_fun_mint_authority_bump_seed = [pump_fun_mint_authority_bump];
    let pump_fun_mint_authority_signer_seeds: &[&[u8]] =
        &[b"mint-authority", &pump_fun_mint_authority_bump_seed];
    let pump_fun_mint_authority_signer: &[&[&[u8]]] =
        &[pump_fun_mint_authority_signer_seeds];

    let base_mint_accounts = MintTo {
        mint: base_mint.to_account_info(),
        to: associated_bonding_curve.to_account_info(),
        authority: pump_fun_mint_authority.to_account_info(),
    };

    mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            base_mint_accounts,
            pump_fun_mint_authority_signer,
        ),
        INITIAL_CURVE_LIQUIDITY,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Fixed mock pump.fun mint authority PDA.
    #[account(
        seeds = [b"mint-authority"],
        bump
    )]
    pub pump_fun_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Mock bonding curve PDA placeholder matching pump.fun naming.
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Mock associated bonding curve token account placeholder.
    #[account(mut)]
    pub associated_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Mock global config PDA placeholder.
    pub global: UncheckedAccount<'info>,

    /// CHECK: Metaplex metadata program placeholder.
    pub mpl_token_metadata: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + LaunchState::INIT_SPACE,
        seeds = [b"metadata", base_mint.key().as_ref()],
        bump
    )]
    pub metadata: Account<'info, LaunchState>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Associated token program placeholder to mirror pump.fun create layout.
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: Rent sysvar placeholder.
    pub rent: UncheckedAccount<'info>,
    /// CHECK: Mock event authority PDA placeholder.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Self program account placeholder.
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateV2<'info> {
    /// CHECK: create_v2 mirrors real pump.fun behavior and may create and initialize
    /// the mint account inside the instruction when it is still empty.
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,

    /// CHECK: Fixed mock pump.fun mint authority PDA.
    #[account(
        seeds = [b"mint-authority"],
        bump
    )]
    pub pump_fun_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Mock bonding curve PDA placeholder matching pump.fun naming.
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Mock associated bonding curve token account placeholder.
    #[account(mut)]
    pub associated_bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Mock global config PDA placeholder.
    pub global: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Associated token program placeholder to mirror pump.fun create_v2 layout.
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: Mayhem program placeholder to mirror pump.fun create_v2 layout.
    pub mayhem_program: UncheckedAccount<'info>,

    /// CHECK: Writable global params placeholder to mirror pump.fun create_v2 layout.
    #[account(mut)]
    pub global_params: UncheckedAccount<'info>,
    /// CHECK: Writable SOL vault placeholder to mirror pump.fun create_v2 layout.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + LaunchState::INIT_SPACE,
        seeds = [b"mayhem-state", base_mint.key().as_ref()],
        bump
    )]
    pub mayhem_state: Account<'info, LaunchState>,
    /// CHECK: Writable mayhem token vault placeholder to mirror pump.fun create_v2 layout.
    #[account(mut)]
    pub mayhem_token_vault: UncheckedAccount<'info>,
    /// CHECK: Mock event authority PDA placeholder to mirror pump.fun create_v2 layout.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Self program account placeholder.
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyExactSolIn<'info> {
    /// CHECK: Mock global config PDA placeholder.
    pub global: UncheckedAccount<'info>,

    /// CHECK: Writable fee recipient placeholder matching pump.fun buy layout.
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Mock bonding curve PDA placeholder matching pump.fun buy naming.
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,

    /// CHECK: Mock associated bonding curve token account placeholder.
    #[account(mut)]
    pub associated_bonding_curve: UncheckedAccount<'info>,

    #[account(mut)]
    pub associated_user: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        signer
    )]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Writable creator vault placeholder matching pump.fun buy layout.
    #[account(mut)]
    pub creator_vault: UncheckedAccount<'info>,
    /// CHECK: Mock event authority PDA placeholder.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Self program account placeholder.
    pub program: UncheckedAccount<'info>,
}

#[error_code]
pub enum MockPumpFunError {
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Wrong mint")]
    WrongMint,

    #[msg("Wrong mint authority")]
    WrongMintAuthority,

    #[msg("Slippage exceeded")]
    SlippageExceeded,

    #[msg("Pump.fun requires WSOL quote mint")]
    PumpFunRequiresWsolQuote,

    #[msg("Launch metadata is too long")]
    LaunchMetadataTooLong,
}
