use anchor_lang::prelude::*;

#[error_code]
pub enum MoonoError {
    #[msg("Unauthorized")]
    Unauthorized,
}
