use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelAuthorizedSignerUpdated;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount};

pub fn handler(ctx: Context<ExecuteUpdateChannelAuthorizedSigner>, token_id: u16) -> Result<()> {
    let channel = &mut ctx.accounts.channel_state;
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);
    require!(
        channel.has_pending_authorized_signer_update(),
        VaultError::NoAuthorizedSignerUpdatePending
    );

    let activate_at = channel
        .authorized_signer_update_requested_at
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        Clock::get()?.unix_timestamp >= activate_at,
        VaultError::WithdrawalLocked
    );

    let previous_authorized_signer = channel.authorized_signer;
    let new_authorized_signer = channel.pending_authorized_signer;
    channel.authorized_signer = new_authorized_signer;
    channel.pending_authorized_signer = Pubkey::default();
    channel.authorized_signer_update_requested_at = 0;

    emit!(ChannelAuthorizedSignerUpdated {
        payer_id: ctx.accounts.payer_account.participant_id,
        payee_id: ctx.accounts.payee_account.participant_id,
        token_id,
        previous_authorized_signer,
        new_authorized_signer,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteUpdateChannelAuthorizedSigner<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub payer_account: Account<'info, ParticipantAccount>,

    #[account(
        seeds = [ParticipantAccount::SEED_PREFIX, payee_account.owner.as_ref()],
        bump,
    )]
    pub payee_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        seeds = [
            ChannelState::SEED_PREFIX,
            payer_account.participant_id.to_le_bytes().as_ref(),
            payee_account.participant_id.to_le_bytes().as_ref(),
            channel_state.token_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub channel_state: Account<'info, ChannelState>,

    pub owner: Signer<'info>,
}
