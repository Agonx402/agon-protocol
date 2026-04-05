use anchor_lang::prelude::*;

#[event]
pub struct ParticipantInitialized {
    pub owner: Pubkey,
    pub participant_id: u32,
    pub registration_fee_lamports: u64,
    pub inbound_channel_policy: u8,
}

#[event]
pub struct ParticipantClosed {
    pub participant_id: u32,
    pub owner: Pubkey,
}

#[event]
pub struct InboundChannelPolicyUpdated {
    pub participant_id: u32,
    pub inbound_channel_policy: u8,
}

#[event]
pub struct ChannelCloseRequested {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub unlock_at: i64,
}

#[event]
pub struct ChannelClosed {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub lane_generation: u32,
    pub final_settled_cumulative: u64,
    pub returned_collateral: u64,
}

#[event]
pub struct ChannelCreated {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub lane_generation: u32,
}

#[event]
pub struct ChannelFundsLocked {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub amount: u64,
    pub total_locked: u64,
}

#[event]
pub struct Deposited {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount: u64,
    pub destination: Pubkey,
    pub unlock_at: i64,
}

#[event]
pub struct WithdrawalCancelled {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount_returned: u64,
}

#[event]
pub struct Withdrawn {
    pub participant_id: u32,
    pub token_id: u16,
    pub net_amount: u64,
    pub fee_amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub chain_id: u16,
}

#[event]
pub struct ConfigAuthorityTransferStarted {
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct ConfigAuthorityTransferred {
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct RegistryAuthorityTransferStarted {
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct RegistryAuthorityTransferred {
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct IndividualSettled {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub lane_generation: u32,
    pub amount: u64,
    pub committed_amount: u64,
    pub from_locked: bool,
    pub fee_amount: u64,
    pub fee_recipient_id: Option<u32>,
}

#[event]
pub struct CommitmentBundleSettled {
    pub payee_id: u32,
    pub token_id: u16,
    pub channel_count: u16,
    pub total: u64,
    pub total_fees: u64,
}

#[event]
pub struct ClearingRoundSettled {
    pub token_id: u16,
    pub participant_count: u16,
    pub channel_count: u16,
    pub total_gross: u64,
    pub total_net_adjusted: u64,
}
