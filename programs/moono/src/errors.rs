use anchor_lang::prelude::*;

#[error_code]
pub enum MoonoError {
    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Asset pool is disabled")]
    AssetPoolDisabled,

    #[msg("Deposits are disabled for this asset pool")]
    DepositsDisabled,

    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Zero shares would be minted")]
    ZeroSharesMinted,

    #[msg("Invariant violation")]
    InvariantViolation,

    #[msg("Invalid LP position")]
    InvalidLpPosition,

    #[msg("Insufficient shares")]
    InsufficientShares,

    #[msg("Zero amount out")]
    ZeroAmountOut,

    #[msg("Wrong mint")]
    WrongMint,

    #[msg("Wrong vault")]
    WrongVault,

    #[msg("Wrong tick page")]
    WrongTickPage,

    #[msg("Protocol is paused")]
    ProtocolPaused,

    #[msg("Borrows are disabled for this asset pool")]
    BorrowsDisabled,

    #[msg("Execution strategy is disabled")]
    StrategyDisabled,

    #[msg("Invalid strategy config")]
    InvalidStrategyConfig,
}
