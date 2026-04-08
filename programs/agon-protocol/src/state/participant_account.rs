use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

use crate::errors::VaultError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboundChannelPolicy {
    Permissionless,
    ConsentRequired,
    Disabled,
}

impl TryFrom<u8> for InboundChannelPolicy {
    type Error = anchor_lang::error::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Permissionless),
            1 => Ok(Self::ConsentRequired),
            2 => Ok(Self::Disabled),
            _ => Err(error!(VaultError::InvalidInboundChannelPolicy)),
        }
    }
}

/// Token-specific balance entry for participants
/// Total: 58 bytes per token balance
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TokenBalance {
    /// 2-byte token identifier from registry
    pub token_id: u16, // 2
    /// Available balance in token's native decimals
    pub available_balance: u64, // 8
    /// Balance locked in pending withdrawal
    pub withdrawing_balance: u64, // 8
    /// Unix timestamp when withdrawal unlockable (0 = none pending)
    pub withdrawal_unlock_at: i64, // 8
    /// Destination ATA for pending withdrawal
    pub withdrawal_destination: Pubkey, // 32
}

#[account]
pub struct ParticipantAccount {
    /// Participant's signing keypair (e.g. Privy smart wallet address)
    pub owner: Pubkey, // 32
    /// Compact numeric ID used in all commitment/netting payloads and PDA seeds
    pub participant_id: u32, //  4
    /// Token-specific balances (up to 16 different tokens per participant)
    pub token_balances: Vec<TokenBalance>, // Variable (up to ~928 bytes for 16 tokens)
    /// PDA bump
    pub bump: u8, //  1
    /// How this participant handles inbound channels created by other parties.
    pub inbound_channel_policy: u8, // 1
    /// Reserved for future participant-level configuration.
    pub _reserved: [u8; 7], // 7
}

impl ParticipantAccount {
    pub const OWNER_OFFSET: usize = 8;
    /// Base space without token balances
    pub const BASE_SPACE: usize = 8 + 32 + 4 + 4 + 1 + 1 + 7; // = 57
    /// Space for one token balance entry
    pub const TOKEN_BALANCE_SPACE: usize = 58;
    /// Maximum token balances per participant
    pub const MAX_TOKEN_BALANCES: usize = 16;
    /// Total space allocation (base + max token balances)
    pub const SPACE: usize =
        Self::BASE_SPACE + (Self::MAX_TOKEN_BALANCES * Self::TOKEN_BALANCE_SPACE); // = 57 + 928 = 985
    pub const SEED_PREFIX: &'static [u8] = b"participant";
    pub const DEFAULT_INBOUND_CHANNEL_POLICY: u8 = InboundChannelPolicy::ConsentRequired as u8;

    /// Raw layout offsets for reading participant-id from remaining_accounts.
    /// Anchor: 8-byte discriminator + owner(32) + participant_id(4).
    pub const PARTICIPANT_ID_OFFSET: usize = 8 + 32; // disc + owner
    pub const PARTICIPANT_ID_SIZE: usize = 4;
    pub const TOKEN_BALANCES_LEN_OFFSET: usize = 8 + 32 + 4;
    pub const TOKEN_BALANCES_DATA_OFFSET: usize = 8 + 32 + 4 + 4;
    pub const TOKEN_BALANCE_TOKEN_ID_OFFSET: usize = 0;
    pub const TOKEN_BALANCE_AVAILABLE_OFFSET: usize = 2;
    pub const TOKEN_BALANCE_WITHDRAWING_OFFSET: usize = 10;
}

impl ParticipantAccount {
    fn require_valid_discriminator(data: &[u8], error_code: VaultError) -> Result<()> {
        let discriminator = Self::DISCRIMINATOR;
        if data.len() < discriminator.len() || !data.starts_with(discriminator) {
            return Err(error_code.into());
        }
        Ok(())
    }

    /// Verify that an AccountInfo is a valid ParticipantAccount PDA.
    /// Use when crediting remaining_accounts (fee_recipient, payees) to prevent state corruption.
    pub fn verify_pda(account_info: &AccountInfo, program_id: &Pubkey) -> Result<()> {
        let data = account_info.try_borrow_data()?;
        Self::require_valid_discriminator(data.as_ref(), VaultError::ParticipantNotFound)?;
        // Use BASE_SPACE (not SPACE) so accounts with fewer than MAX_TOKEN_BALANCES entries pass.
        require!(
            data.len() >= ParticipantAccount::BASE_SPACE,
            VaultError::ParticipantNotFound
        );
        let owner_bytes: [u8; 32] = data[8..40]
            .try_into()
            .map_err(|_| VaultError::ParticipantNotFound)?;
        let owner_pubkey = Pubkey::new_from_array(owner_bytes);
        let (expected_pda, _) = Pubkey::find_program_address(
            &[ParticipantAccount::SEED_PREFIX, owner_pubkey.as_ref()],
            program_id,
        );
        require!(
            account_info.key() == expected_pda,
            VaultError::ParticipantNotFound
        );
        Ok(())
    }

    /// Verify a program-owned participant account matches the expected participant id.
    /// Useful for `remaining_accounts` validation before manual deserialization.
    pub fn verify_expected_account(
        account_info: &AccountInfo,
        program_id: &Pubkey,
        expected_participant_id: u32,
    ) -> Result<()> {
        require!(
            account_info.owner == program_id,
            VaultError::AccountIdMismatch
        );
        let data = account_info.try_borrow_data()?;
        Self::require_valid_discriminator(data.as_ref(), VaultError::AccountIdMismatch)?;
        require!(
            data.len() >= ParticipantAccount::BASE_SPACE,
            VaultError::AccountIdMismatch
        );
        let participant_id = u32::from_le_bytes(
            data[ParticipantAccount::PARTICIPANT_ID_OFFSET
                ..ParticipantAccount::PARTICIPANT_ID_OFFSET
                    + ParticipantAccount::PARTICIPANT_ID_SIZE]
                .try_into()
                .map_err(|_| error!(VaultError::AccountIdMismatch))?,
        );
        require!(
            participant_id == expected_participant_id,
            VaultError::AccountIdMismatch
        );
        drop(data);
        Self::verify_pda(account_info, program_id)
    }

    pub fn read_owner_and_id(data: &[u8]) -> Result<(Pubkey, u32)> {
        Self::require_valid_discriminator(data, VaultError::ParticipantNotFound)?;
        require!(
            data.len() >= ParticipantAccount::BASE_SPACE,
            VaultError::ParticipantNotFound
        );
        let owner = Pubkey::new_from_array(
            data[Self::OWNER_OFFSET..Self::OWNER_OFFSET + 32]
                .try_into()
                .map_err(|_| error!(VaultError::ParticipantNotFound))?,
        );
        let participant_id = u32::from_le_bytes(
            data[Self::PARTICIPANT_ID_OFFSET
                ..Self::PARTICIPANT_ID_OFFSET + Self::PARTICIPANT_ID_SIZE]
                .try_into()
                .map_err(|_| error!(VaultError::ParticipantNotFound))?,
        );
        Ok((owner, participant_id))
    }

    pub fn read_owner_id_and_bump(data: &[u8]) -> Result<(Pubkey, u32, u8)> {
        Self::require_valid_discriminator(data, VaultError::ParticipantNotFound)?;
        let (owner, participant_id) = Self::read_owner_and_id(data)?;
        let token_balance_count = u32::from_le_bytes(
            data[Self::TOKEN_BALANCES_LEN_OFFSET..Self::TOKEN_BALANCES_LEN_OFFSET + 4]
                .try_into()
                .map_err(|_| error!(VaultError::ParticipantNotFound))?,
        ) as usize;
        let bump_offset = Self::TOKEN_BALANCES_DATA_OFFSET
            .checked_add(
                token_balance_count
                    .checked_mul(Self::TOKEN_BALANCE_SPACE)
                    .ok_or(error!(VaultError::ParticipantNotFound))?,
            )
            .ok_or(error!(VaultError::ParticipantNotFound))?;
        require!(data.len() > bump_offset, VaultError::ParticipantNotFound);
        Ok((owner, participant_id, data[bump_offset]))
    }

    pub fn verify_pda_from_raw_fields(
        account_key: &Pubkey,
        owner: &Pubkey,
        bump: u8,
        program_id: &Pubkey,
    ) -> Result<()> {
        let expected_pda = Pubkey::create_program_address(
            &[Self::SEED_PREFIX, owner.as_ref(), &[bump]],
            program_id,
        )
        .map_err(|_| error!(VaultError::ParticipantNotFound))?;
        require!(
            *account_key == expected_pda,
            VaultError::ParticipantNotFound
        );
        Ok(())
    }

    pub fn read_token_total_balance_from_data(data: &[u8], token_id: u16) -> Result<u64> {
        Self::require_valid_discriminator(data, VaultError::ParticipantNotFound)?;
        require!(
            data.len() >= Self::TOKEN_BALANCES_DATA_OFFSET,
            VaultError::ParticipantNotFound
        );

        let token_balance_count = u32::from_le_bytes(
            data[Self::TOKEN_BALANCES_LEN_OFFSET..Self::TOKEN_BALANCES_LEN_OFFSET + 4]
                .try_into()
                .map_err(|_| error!(VaultError::ParticipantNotFound))?,
        ) as usize;

        let mut offset = Self::TOKEN_BALANCES_DATA_OFFSET;
        for _ in 0..token_balance_count {
            require!(
                data.len() >= offset + Self::TOKEN_BALANCE_SPACE,
                VaultError::ParticipantNotFound
            );
            let entry_token_id = u16::from_le_bytes(
                data[offset + Self::TOKEN_BALANCE_TOKEN_ID_OFFSET
                    ..offset + Self::TOKEN_BALANCE_TOKEN_ID_OFFSET + 2]
                    .try_into()
                    .map_err(|_| error!(VaultError::ParticipantNotFound))?,
            );
            if entry_token_id == token_id {
                let available_balance = u64::from_le_bytes(
                    data[offset + Self::TOKEN_BALANCE_AVAILABLE_OFFSET
                        ..offset + Self::TOKEN_BALANCE_AVAILABLE_OFFSET + 8]
                        .try_into()
                        .map_err(|_| error!(VaultError::ParticipantNotFound))?,
                );
                let withdrawing_balance = u64::from_le_bytes(
                    data[offset + Self::TOKEN_BALANCE_WITHDRAWING_OFFSET
                        ..offset + Self::TOKEN_BALANCE_WITHDRAWING_OFFSET + 8]
                        .try_into()
                        .map_err(|_| error!(VaultError::ParticipantNotFound))?,
                );
                return available_balance
                    .checked_add(withdrawing_balance)
                    .ok_or(error!(VaultError::MathOverflow));
            }
            offset += Self::TOKEN_BALANCE_SPACE;
        }

        Ok(0)
    }

    pub fn read_token_total_balance_or_zero_from_data(data: &[u8], token_id: u16) -> Result<u64> {
        Self::require_valid_discriminator(data, VaultError::ParticipantNotFound)?;
        require!(
            data.len() >= Self::TOKEN_BALANCES_DATA_OFFSET,
            VaultError::ParticipantNotFound
        );

        let token_balance_count = u32::from_le_bytes(
            data[Self::TOKEN_BALANCES_LEN_OFFSET..Self::TOKEN_BALANCES_LEN_OFFSET + 4]
                .try_into()
                .map_err(|_| error!(VaultError::ParticipantNotFound))?,
        ) as usize;

        let mut offset = Self::TOKEN_BALANCES_DATA_OFFSET;
        for _ in 0..token_balance_count {
            require!(
                data.len() >= offset + Self::TOKEN_BALANCE_SPACE,
                VaultError::ParticipantNotFound
            );
            let entry_token_id = u16::from_le_bytes(
                data[offset + Self::TOKEN_BALANCE_TOKEN_ID_OFFSET
                    ..offset + Self::TOKEN_BALANCE_TOKEN_ID_OFFSET + 2]
                    .try_into()
                    .map_err(|_| error!(VaultError::ParticipantNotFound))?,
            );
            if entry_token_id == token_id {
                let available_balance = u64::from_le_bytes(
                    data[offset + Self::TOKEN_BALANCE_AVAILABLE_OFFSET
                        ..offset + Self::TOKEN_BALANCE_AVAILABLE_OFFSET + 8]
                        .try_into()
                        .map_err(|_| error!(VaultError::ParticipantNotFound))?,
                );
                let withdrawing_balance = u64::from_le_bytes(
                    data[offset + Self::TOKEN_BALANCE_WITHDRAWING_OFFSET
                        ..offset + Self::TOKEN_BALANCE_WITHDRAWING_OFFSET + 8]
                        .try_into()
                        .map_err(|_| error!(VaultError::ParticipantNotFound))?,
                );
                return available_balance
                    .checked_add(withdrawing_balance)
                    .ok_or(error!(VaultError::MathOverflow));
            }
            offset += Self::TOKEN_BALANCE_SPACE;
        }

        Ok(0)
    }

    /// Find or create token balance entry
    pub fn get_token_balance_mut(&mut self, token_id: u16) -> Result<&mut TokenBalance> {
        // Find existing balance index
        if let Some(index) = self
            .token_balances
            .iter()
            .position(|b| b.token_id == token_id)
        {
            return Ok(&mut self.token_balances[index]);
        }

        // Create new balance if under limit
        require!(
            self.token_balances.len() < Self::MAX_TOKEN_BALANCES,
            VaultError::TooManyTokenBalances
        );

        self.token_balances.push(TokenBalance {
            token_id,
            available_balance: 0,
            withdrawing_balance: 0,
            withdrawal_unlock_at: 0,
            withdrawal_destination: Pubkey::default(),
        });

        let len = self.token_balances.len();
        Ok(&mut self.token_balances[len - 1])
    }

    /// Get token balance (read-only)
    pub fn get_token_balance(&self, token_id: u16) -> Option<&TokenBalance> {
        self.token_balances.iter().find(|b| b.token_id == token_id)
    }

    /// Credit token balance
    pub fn credit_token(&mut self, token_id: u16, amount: u64) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;
        balance.available_balance = balance
            .available_balance
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        Ok(())
    }

    /// Debit token balance
    pub fn debit_token(&mut self, token_id: u16, amount: u64) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;

        let total_balance = balance
            .available_balance
            .checked_add(balance.withdrawing_balance)
            .ok_or(error!(VaultError::MathOverflow))?;

        require!(total_balance >= amount, VaultError::InsufficientBalance);

        if balance.available_balance >= amount {
            balance.available_balance -= amount;
        } else {
            let remainder = amount - balance.available_balance;
            balance.available_balance = 0;
            balance.withdrawing_balance -= remainder;
        }
        Ok(())
    }

    /// Initiate token withdrawal
    pub fn initiate_token_withdrawal(
        &mut self,
        token_id: u16,
        amount: u64,
        destination: Pubkey,
        unlock_at: i64,
    ) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;

        require!(
            balance.available_balance >= amount,
            VaultError::InsufficientBalance
        );

        balance.available_balance -= amount;
        balance.withdrawing_balance = balance
            .withdrawing_balance
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        balance.withdrawal_destination = destination;
        balance.withdrawal_unlock_at = unlock_at;

        Ok(())
    }

    /// Get total balance for a specific token
    pub fn get_token_total_balance(&self, token_id: u16) -> Result<u64> {
        let balance = self
            .get_token_balance(token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;

        balance
            .available_balance
            .checked_add(balance.withdrawing_balance)
            .ok_or(error!(VaultError::MathOverflow))
    }

    pub fn inbound_channel_policy(&self) -> Result<InboundChannelPolicy> {
        InboundChannelPolicy::try_from(self.inbound_channel_policy)
    }

    pub fn set_inbound_channel_policy(&mut self, policy: InboundChannelPolicy) {
        self.inbound_channel_policy = policy as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_token_balance(token_id: u16, available_balance: u64) -> TokenBalance {
        TokenBalance {
            token_id,
            available_balance,
            withdrawing_balance: available_balance / 2,
            withdrawal_unlock_at: 123,
            withdrawal_destination: Pubkey::new_unique(),
        }
    }

    fn sample_participant(token_balances: Vec<TokenBalance>) -> ParticipantAccount {
        ParticipantAccount {
            owner: Pubkey::new_unique(),
            participant_id: 42,
            token_balances,
            bump: 7,
            inbound_channel_policy: ParticipantAccount::DEFAULT_INBOUND_CHANNEL_POLICY,
            _reserved: [0u8; 7],
        }
    }

    #[test]
    fn space_covers_max_participant_payload() {
        let participant = sample_participant(
            (0..ParticipantAccount::MAX_TOKEN_BALANCES)
                .map(|i| sample_token_balance(i as u16 + 1, 1_000 + i as u64))
                .collect(),
        );

        let mut serialized = Vec::new();
        participant
            .try_serialize(&mut serialized)
            .expect("participant should serialize");

        assert_eq!(ParticipantAccount::BASE_SPACE, 57);
        assert_eq!(serialized.len(), ParticipantAccount::SPACE - 8);
    }

    #[test]
    fn raw_field_readers_match_current_layout() {
        let participant = sample_participant(vec![
            sample_token_balance(1, 10),
            sample_token_balance(2, 20),
        ]);

        let mut account_data = vec![0u8; 8];
        participant
            .try_serialize(&mut account_data)
            .expect("participant should serialize");

        let (owner, participant_id) =
            ParticipantAccount::read_owner_and_id(account_data.as_slice()).unwrap();
        assert_eq!(owner, participant.owner);
        assert_eq!(participant_id, participant.participant_id);

        let (owner_with_bump, participant_id_with_bump, bump) =
            ParticipantAccount::read_owner_id_and_bump(account_data.as_slice()).unwrap();
        assert_eq!(owner_with_bump, participant.owner);
        assert_eq!(participant_id_with_bump, participant.participant_id);
        assert_eq!(bump, participant.bump);

        let token_two_total =
            ParticipantAccount::read_token_total_balance_from_data(account_data.as_slice(), 2)
                .unwrap();
        assert_eq!(token_two_total, 30);

        let missing_total = ParticipantAccount::read_token_total_balance_or_zero_from_data(
            account_data.as_slice(),
            999,
        )
        .unwrap();
        assert_eq!(missing_total, 0);
    }

    #[test]
    fn verify_pda_from_raw_fields_matches_participant_seed_scheme() {
        let owner = Pubkey::new_unique();
        let (participant_pda, bump) = Pubkey::find_program_address(
            &[ParticipantAccount::SEED_PREFIX, owner.as_ref()],
            &crate::id(),
        );

        ParticipantAccount::verify_pda_from_raw_fields(
            &participant_pda,
            &owner,
            bump,
            &crate::id(),
        )
        .expect("derived participant PDA should verify");
    }

    #[test]
    fn raw_readers_reject_wrong_discriminator() {
        let participant = sample_participant(vec![sample_token_balance(1, 10)]);
        let mut account_data = vec![0u8; 8];
        participant
            .try_serialize(&mut account_data)
            .expect("participant should serialize");
        account_data[0] ^= 0xff;

        assert!(ParticipantAccount::read_owner_and_id(account_data.as_slice()).is_err());
        assert!(
            ParticipantAccount::read_token_total_balance_or_zero_from_data(
                account_data.as_slice(),
                1
            )
            .is_err()
        );
    }
}
