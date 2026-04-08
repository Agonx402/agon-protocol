use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelFundsUnlocked;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount};

pub fn handler(ctx: Context<ExecuteUnlockChannelFunds>, token_id: u16) -> Result<()> {
    let channel = &mut ctx.accounts.channel_state;
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);
    require!(
        channel.has_pending_unlock(),
        VaultError::NoChannelUnlockPending
    );

    let unlock_at = channel
        .unlock_requested_at
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        Clock::get()?.unix_timestamp >= unlock_at,
        VaultError::WithdrawalLocked
    );

    let released_amount = channel.pending_unlock_amount.min(channel.locked_balance);
    if released_amount > 0 {
        ctx.accounts
            .payer_account
            .credit_token(token_id, released_amount)?;
        channel.locked_balance = channel
            .locked_balance
            .checked_sub(released_amount)
            .ok_or(error!(VaultError::MathOverflow))?;
    }

    channel.pending_unlock_amount = 0;
    channel.unlock_requested_at = 0;

    emit!(ChannelFundsUnlocked {
        payer_id: ctx.accounts.payer_account.participant_id,
        payee_id: ctx.accounts.payee_account.participant_id,
        token_id,
        released_amount,
        remaining_locked: channel.locked_balance,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteUnlockChannelFunds<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        mut,
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
