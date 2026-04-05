use anchor_lang::prelude::*;

#[account]
pub struct LaneState {
    /// Monotonic generation for a payer->payee->token lane. Incremented on each reopen.
    pub current_generation: u32, // 4
    /// PDA bump
    pub bump: u8, // 1
}

impl LaneState {
    /// Total account size including 8-byte discriminator.
    pub const SPACE: usize = 8 + 4 + 1; // = 13
    pub const SEED_PREFIX: &'static [u8] = b"lane-state";
}
