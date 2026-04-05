use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelClosed;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount, TokenRegistry};

pub fn handler(ctx: Context<ExecuteCloseChannel>, token_id: u16) -> Result<()> {
    let channel = &ctx.accounts.channel_state;
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);

    // Must have been requested
    require!(
        channel.close_requested_at != 0,
        VaultError::ChannelNotClosing
    );

    // Timelock must have expired
    let clock = Clock::get()?;
    let unlock_at = channel
        .close_requested_at
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        clock.unix_timestamp >= unlock_at,
        VaultError::WithdrawalLocked
    );

    // Return any locked collateral to payer (token-specific)
    let returned_collateral = channel.locked_balance;
    let final_settled_cumulative = channel.settled_cumulative;
    let lane_generation = channel.lane_generation;
    let payer_id = ctx.accounts.payer_account.participant_id;
    let payee_id = ctx.accounts.payee_account.participant_id;
    let is_self_channel = ctx.accounts.payer_account.key() == ctx.accounts.payee_account.key();
    if returned_collateral > 0 {
        ctx.accounts
            .payer_account
            .credit_token(token_id, returned_collateral)?;
    }
    ctx.accounts.payer_account.decrement_open_channels()?;
    if !is_self_channel {
        ctx.accounts.payee_account.decrement_open_channels()?;
    }

    emit!(ChannelClosed {
        payer_id,
        payee_id,
        token_id,
        lane_generation,
        final_settled_cumulative,
        returned_collateral,
    });

    // Account is closed via the `close` attribute in Accounts struct
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteCloseChannel<'info> {
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
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, payer_account.owner.as_ref()],
        bump,
    )]
    pub payer_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
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
        close = rent_recipient,
    )]
    pub channel_state: Account<'info, ChannelState>,

    /// CHECK: Validated by constraint — must equal payer_account.owner (receives channel rent).
    #[account(
        mut,
        constraint = rent_recipient.key() == payer_account.owner @ VaultError::InvalidRentRecipient,
    )]
    pub rent_recipient: UncheckedAccount<'info>,
}
