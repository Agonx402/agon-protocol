use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelClosed;
use crate::state::{ChannelState, ParticipantAccount, TokenRegistry};

pub fn handler(ctx: Context<ExecuteCloseChannelInstant>, token_id: u16) -> Result<()> {
    let channel = &ctx.accounts.channel_state;

    // Validate token matches channel
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);

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
pub struct ExecuteCloseChannelInstant<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        mut,
        has_one = owner @ VaultError::AccountIdMismatch,
    )]
    pub payer_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        constraint = payee_account.owner == payee_signer.key() @ VaultError::AccountIdMismatch,
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

    /// Payer signs
    pub owner: Signer<'info>,

    /// Payee also signs (mutual consent)
    pub payee_signer: Signer<'info>,
}
