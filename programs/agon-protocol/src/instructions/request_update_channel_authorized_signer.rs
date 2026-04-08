use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelAuthorizedSignerUpdateRequested;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount};

pub fn handler(
    ctx: Context<RequestUpdateChannelAuthorizedSigner>,
    token_id: u16,
    new_signer: Pubkey,
) -> Result<()> {
    let channel = &mut ctx.accounts.channel_state;
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);
    require!(
        new_signer != Pubkey::default() && new_signer != channel.authorized_signer,
        VaultError::InvalidAuthorizedSigner
    );

    let clock = Clock::get()?;
    let activate_at = clock
        .unix_timestamp
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    let current_authorized_signer = channel.authorized_signer;

    channel.pending_authorized_signer = new_signer;
    channel.authorized_signer_update_requested_at = clock.unix_timestamp;

    emit!(ChannelAuthorizedSignerUpdateRequested {
        payer_id: ctx.accounts.payer_account.participant_id,
        payee_id: ctx.accounts.payee_account.participant_id,
        token_id,
        current_authorized_signer,
        pending_authorized_signer: new_signer,
        activate_at,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RequestUpdateChannelAuthorizedSigner<'info> {
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
