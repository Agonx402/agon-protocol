use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelCloseRequested;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount, TokenRegistry};

pub fn handler(ctx: Context<RequestCloseChannel>, token_id: u16) -> Result<()> {
    let channel = &mut ctx.accounts.channel_state;
    let payer = &ctx.accounts.payer_account;
    let payee = &ctx.accounts.payee_account;
    let config = &ctx.accounts.global_config;
    let requester = ctx.accounts.requester.key();

    require!(
        requester == payer.owner || requester == payee.owner,
        VaultError::UnauthorizedChannelCloseRequester
    );

    // Validate token matches channel
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);

    // Channel must not already be closing
    require!(
        channel.close_requested_at == 0,
        VaultError::ChannelAlreadyClosing
    );

    let clock = Clock::get()?;
    channel.close_requested_at = clock.unix_timestamp;

    let unlock_at = clock
        .unix_timestamp
        .checked_add(config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(ChannelCloseRequested {
        payer_id: payer.participant_id,
        payee_id: payee.participant_id,
        token_id,
        unlock_at,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RequestCloseChannel<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [ParticipantAccount::SEED_PREFIX, payer_account.owner.as_ref()],
        bump,
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
            channel_state.token_id.to_le_bytes().as_ref(), // Include token_id from account data
        ],
        bump,
    )]
    pub channel_state: Account<'info, ChannelState>,

    pub requester: Signer<'info>,
}
