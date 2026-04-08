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
    /// Token amount locked as ring-fenced collateral (0 = no lock)
    pub locked_balance: u64, // 8
    /// Signer authorized to advance this channel's cumulative commitment.
    pub authorized_signer: Pubkey, // 32
    /// Amount the payer most recently requested to unlock after the timelock.
    pub pending_unlock_amount: u64, // 8
    /// Unix timestamp when the latest unlock request was created (0 = none pending).
    pub unlock_requested_at: i64, // 8
    /// Signer that will replace `authorized_signer` once the rotation timelock elapses.
    pub pending_authorized_signer: Pubkey, // 32
    /// Unix timestamp when the latest signer-rotation request was created (0 = none pending).
    pub authorized_signer_update_requested_at: i64, // 8
    /// PDA bump
    pub bump: u8, // 1
}

impl ChannelState {
    /// Total account size including Anchor discriminator (8 bytes).
    /// Layout: disc(8) + token_id(2) + payer_id(4) + payee_id(4)
    ///       + settled_cumulative(8) + locked_balance(8) + authorized_signer(32)
    ///       + pending_unlock_amount(8) + unlock_requested_at(8)
    ///       + pending_authorized_signer(32)
    ///       + authorized_signer_update_requested_at(8) + bump(1) = 115
    pub const SPACE: usize = 8 + 2 + 4 + 4 + 8 + 8 + 32 + 8 + 8 + 32 + 8 + 1; // = 123
    pub const SEED_PREFIX: &'static [u8] = b"channel-v2";

    // Raw byte offsets (including 8-byte discriminator) for manual reads in remaining_accounts
    pub const TOKEN_ID_OFFSET: usize = 8; // [8..10]
    pub const PAYER_ID_OFFSET: usize = 10; // [10..14]
    pub const PAYEE_ID_OFFSET: usize = 14; // [14..18]
    pub const SETTLED_CUMULATIVE_OFFSET: usize = 18; // [18..26]
    pub const LOCKED_BALANCE_OFFSET: usize = 26; // [26..34]
    pub const AUTHORIZED_SIGNER_OFFSET: usize = 34; // [34..66]
    pub const PENDING_UNLOCK_AMOUNT_OFFSET: usize = 66; // [66..74]
    pub const UNLOCK_REQUESTED_AT_OFFSET: usize = 74; // [74..82]
    pub const PENDING_AUTHORIZED_SIGNER_OFFSET: usize = 82; // [82..114]
    pub const AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET: usize = 114; // [114..122]
    pub const BUMP_OFFSET: usize = 122; // [122]

    pub fn has_pending_unlock(&self) -> bool {
        self.pending_unlock_amount > 0 && self.unlock_requested_at != 0
    }

    pub fn has_pending_authorized_signer_update(&self) -> bool {
        self.pending_authorized_signer != Pubkey::default()
            && self.authorized_signer_update_requested_at != 0
    }

    pub fn verify_expected_pda(
        account_key: &Pubkey,
        payer_id: u32,
        payee_id: u32,
        token_id: u16,
        bump: u8,
        program_id: &Pubkey,
    ) -> Result<()> {
        let payer_id_bytes = payer_id.to_le_bytes();
        let payee_id_bytes = payee_id.to_le_bytes();
        let token_id_bytes = token_id.to_le_bytes();
        let expected_pda = Pubkey::create_program_address(
            &[
                Self::SEED_PREFIX,
                payer_id_bytes.as_ref(),
                payee_id_bytes.as_ref(),
                token_id_bytes.as_ref(),
                &[bump],
            ],
            program_id,
        )
        .map_err(|_| error!(crate::errors::VaultError::ChannelNotInitialized))?;
        require!(
            *account_key == expected_pda,
            crate::errors::VaultError::ChannelNotInitialized
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_expected_pda_matches_channel_seed_scheme() {
        let payer_id = 11u32;
        let payee_id = 22u32;
        let token_id = 7u16;
        let payer_id_bytes = payer_id.to_le_bytes();
        let payee_id_bytes = payee_id.to_le_bytes();
        let token_id_bytes = token_id.to_le_bytes();
        let (channel_pda, bump) = Pubkey::find_program_address(
            &[
                ChannelState::SEED_PREFIX,
                payer_id_bytes.as_ref(),
                payee_id_bytes.as_ref(),
                token_id_bytes.as_ref(),
            ],
            &crate::id(),
        );

        ChannelState::verify_expected_pda(
            &channel_pda,
            payer_id,
            payee_id,
            token_id,
            bump,
            &crate::id(),
        )
        .expect("derived channel PDA should verify");
    }
}
