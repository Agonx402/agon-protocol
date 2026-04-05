use anchor_lang::prelude::*;

mod balance_deltas;

pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::cancel_withdrawal::*;
use instructions::close_participant::*;
use instructions::create_channel::*;
use instructions::deposit::*;
use instructions::deposit_for::*;
use instructions::execute_close_channel::*;
use instructions::execute_close_channel_instant::*;
use instructions::execute_withdrawal_timelocked::*;
use instructions::initialize::*;
use instructions::initialize_participant::*;
use instructions::lock_channel_funds::*;
use instructions::request_close_channel::*;
use instructions::request_withdrawal::*;
use instructions::settle_clearing_round::*;
use instructions::settle_commitment_bundle::*;
use instructions::settle_individual::*;
use instructions::token_registry::*;
use instructions::update_config::*;
use instructions::update_inbound_channel_policy::*;

declare_id!("9Kwxe9mqisMPsyFknepXAahSodEymFGgkFwqYJHvp45K");

#[program]
pub mod agon_protocol {
    use super::*;

    /// Initialize the protocol: creates GlobalConfig PDA.
    /// `chain_id` selects the immutable settlement domain and withdrawal timelock.
    pub fn initialize(
        ctx: Context<Initialize>,
        chain_id: u16,
        fee_bps: u16,
        registration_fee_lamports: u64,
        message_domain: [u8; 16],
        initial_authority: Option<Pubkey>,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            chain_id,
            fee_bps,
            registration_fee_lamports,
            message_domain,
            initial_authority,
        )
    }

    /// Update protocol configuration (authority only).
    /// Settlement chain_id and withdrawal timelock are immutable and cannot be changed.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_authority: Option<Pubkey>,
        new_fee_recipient: Option<Pubkey>,
        new_fee_bps: Option<u16>,
        new_registration_fee_lamports: Option<u64>,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            new_authority,
            new_fee_recipient,
            new_fee_bps,
            new_registration_fee_lamports,
        )
    }

    /// Pending config authority accepts the handoff.
    pub fn accept_config_authority(ctx: Context<AcceptConfigAuthority>) -> Result<()> {
        instructions::update_config::accept_config_authority(ctx)
    }

    /// One-time participant registration.
    pub fn initialize_participant(ctx: Context<InitializeParticipant>) -> Result<()> {
        instructions::initialize_participant::handler(ctx)
    }

    /// Update the participant's inbound channel policy.
    pub fn update_inbound_channel_policy(
        ctx: Context<UpdateInboundChannelPolicy>,
        inbound_channel_policy: u8,
    ) -> Result<()> {
        instructions::update_inbound_channel_policy::handler(ctx, inbound_channel_policy)
    }

    /// Deposit tokens into the vault (credits signer's vault).
    pub fn deposit(ctx: Context<Deposit>, token_id: u16, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, token_id, amount)
    }

    /// Deposit a registered token for multiple participants in one tx.
    /// Funder's ATA to vault; credits each recipient.
    /// amounts.len() must equal remaining_accounts (ParticipantAccounts). Max 16 recipients.
    pub fn deposit_for(ctx: Context<DepositFor>, token_id: u16, amounts: Vec<u64>) -> Result<()> {
        instructions::deposit_for::handler(ctx, token_id, amounts)
    }

    /// Request a timelocked withdrawal for a specific token.
    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        token_id: u16,
        amount: u64,
        destination: Pubkey,
    ) -> Result<()> {
        instructions::request_withdrawal::handler(ctx, token_id, amount, destination)
    }

    /// Cancel a pending withdrawal for a specific token.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>, token_id: u16) -> Result<()> {
        instructions::cancel_withdrawal::handler(ctx, token_id)
    }

    /// Execute a withdrawal for a specific token after timelock expires.
    pub fn execute_withdrawal_timelocked(
        ctx: Context<ExecuteWithdrawalTimelocked>,
        token_id: u16,
    ) -> Result<()> {
        instructions::execute_withdrawal_timelocked::handler(ctx, token_id)
    }

    /// Close a participant account (requires zero balance).
    pub fn close_participant(ctx: Context<CloseParticipant>) -> Result<()> {
        instructions::close_participant::handler(ctx)
    }

    /// Create a token-specific channel from payer to payee. Must be called before any payment commitments are signed or settled.
    /// Payer signs and pays ~0.002 SOL rent. Ensures payees and facilitators never pay for creation.
    pub fn create_channel(
        ctx: Context<CreateChannel>,
        token_id: u16,
        authorized_signer: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_channel::handler(ctx, token_id, authorized_signer)
    }

    /// Initiate 7-day channel closure grace period.
    pub fn request_close_channel(ctx: Context<RequestCloseChannel>, token_id: u16) -> Result<()> {
        instructions::request_close_channel::handler(ctx, token_id)
    }

    /// Execute channel closure after 7-day grace period (permissionless).
    pub fn execute_close_channel(ctx: Context<ExecuteCloseChannel>, token_id: u16) -> Result<()> {
        instructions::execute_close_channel::handler(ctx, token_id)
    }

    /// Instant channel closure with mutual consent (both parties sign).
    pub fn execute_close_channel_instant(
        ctx: Context<ExecuteCloseChannelInstant>,
        token_id: u16,
    ) -> Result<()> {
        instructions::execute_close_channel_instant::handler(ctx, token_id)
    }

    /// Lock tokens as ring-fenced collateral for a specific payee channel.
    pub fn lock_channel_funds(
        ctx: Context<LockChannelFunds>,
        token_id: u16,
        amount: u64,
    ) -> Result<()> {
        instructions::lock_channel_funds::handler(ctx, token_id, amount)
    }

    /// Settle a single payment commitment. Submitter must be the payee or an authorized settler.
    pub fn settle_individual(ctx: Context<SettleIndividual>) -> Result<()> {
        instructions::settle_individual::handler(ctx)
    }

    /// Settle many latest commitments for one payee across many unilateral channels.
    pub fn settle_commitment_bundle<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleCommitmentBundle<'info>>,
        count: u8,
    ) -> Result<()> {
        instructions::settle_commitment_bundle::handler(ctx, count)
    }

    /// Cooperative clearing round: advances many channels and applies only net participant balance changes.
    pub fn settle_clearing_round<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleClearingRound<'info>>,
    ) -> Result<()> {
        instructions::settle_clearing_round::handler(ctx)
    }

    /// Initialize the token registry (authority only, called once after program deployment).
    pub fn initialize_token_registry(ctx: Context<InitializeTokenRegistry>) -> Result<()> {
        instructions::token_registry::initialize_token_registry(ctx)
    }

    /// Register a new token in the registry (authority only).
    pub fn register_token(
        ctx: Context<RegisterToken>,
        token_id: u16,
        symbol_bytes: [u8; 8],
    ) -> Result<()> {
        instructions::token_registry::register_token(ctx, token_id, symbol_bytes)
    }

    /// Nominate a pending token registry authority.
    pub fn update_registry_authority(
        ctx: Context<UpdateRegistryAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::token_registry::update_registry_authority(ctx, new_authority)
    }

    /// Pending token registry authority accepts the handoff.
    pub fn accept_registry_authority(ctx: Context<AcceptRegistryAuthority>) -> Result<()> {
        instructions::token_registry::accept_registry_authority(ctx)
    }
}
