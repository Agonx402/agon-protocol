use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelUnlockRequested;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount};

pub fn handler(ctx: Context<RequestUnlockChannelFunds>, token_id: u16, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);

    let channel = &mut ctx.accounts.channel_state;
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);
    require!(
        amount <= channel.locked_balance,
        VaultError::InsufficientLockedBalance
    );

    let clock = Clock::get()?;
    let unlock_at = clock
        .unix_timestamp
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;

    channel.pending_unlock_amount = amount;
    channel.unlock_requested_at = clock.unix_timestamp;

    emit!(ChannelUnlockRequested {
        payer_id: ctx.accounts.payer_account.participant_id,
        payee_id: ctx.accounts.payee_account.participant_id,
        token_id,
        requested_amount: amount,
        unlock_at,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RequestUnlockChannelFunds<'info> {
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
