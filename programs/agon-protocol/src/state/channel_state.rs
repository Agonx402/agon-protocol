use anchor_lang::prelude::*;

#[account]
pub struct ChannelState {
    /// Token ID for this channel (from token registry)
    pub token_id: u16, // 2
    /// Cached payer participant id for validation and events.
    pub payer_id: u32, // 4
    /// Cached payee participant id for validation and events.
    pub payee_id: u32, // 4
    /// Highest cumulative committed amount already settled for this lane.
    pub settled_cumulative: u64, // 8
    /// Unix timestamp when payer requested channel closure (0 = not requested)
    pub close_requested_at: i64, // 8
    /// Token amount locked as ring-fenced collateral (0 = no lock)
    pub locked_balance: u64, // 8
    /// Signer authorized to advance this channel's cumulative commitment.
    pub authorized_signer: Pubkey, // 32
    /// Monotonic lane generation used by v3 message replay protection.
    pub lane_generation: u32, // 4
    /// PDA bump
    pub bump: u8, // 1
}

impl ChannelState {
    /// Total account size including Anchor discriminator (8 bytes).
    /// Layout: disc(8) + token_id(2) + payer_id(4) + payee_id(4)
    ///       + settled_cumulative(8) + close_requested_at(8) + locked_balance(8)
    ///       + authorized_signer(32) + lane_generation(4) + bump(1) = 79
    pub const SPACE: usize = 8 + 2 + 4 + 4 + 8 + 8 + 8 + 32 + 4 + 1; // = 79
    pub const SEED_PREFIX: &'static [u8] = b"channel-v1";

    // Raw byte offsets (including 8-byte discriminator) for manual reads in remaining_accounts
    pub const TOKEN_ID_OFFSET: usize = 8; // [8..10]
    pub const PAYER_ID_OFFSET: usize = 10; // [10..14]
    pub const PAYEE_ID_OFFSET: usize = 14; // [14..18]
    pub const SETTLED_CUMULATIVE_OFFSET: usize = 18; // [18..26]
    pub const CLOSE_REQ_OFFSET: usize = 26; // [26..34]
    pub const LOCKED_BALANCE_OFFSET: usize = 34; // [34..42]
    pub const AUTHORIZED_SIGNER_OFFSET: usize = 42; // [42..74]
    pub const LANE_GENERATION_OFFSET: usize = 74; // [74..78]
    pub const BUMP_OFFSET: usize = 78; // [78]
}
