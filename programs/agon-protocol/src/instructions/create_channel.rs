use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelCreated;
use crate::state::{
    ChannelState, InboundChannelPolicy, LaneState, ParticipantAccount, TokenRegistry,
};

/// Create a channel from payer to payee. Must be called before any payment commitments are signed or settled.
/// Payer signs and pays the ~0.002 SOL rent. Ensures predictable UX: payees and facilitators
/// never pay for channel creation.
pub fn handler(
    ctx: Context<CreateChannel>,
    token_id: u16,
    authorized_signer: Option<Pubkey>,
) -> Result<()> {
    // Validate token is registered
    ctx.accounts
        .token_registry
        .find_token(token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let is_self_channel = ctx.accounts.payer_account.owner == ctx.accounts.payee_account.owner;
    if !is_self_channel {
        if let Some(payee_owner) = ctx.accounts.payee_owner.as_ref() {
            require!(
                payee_owner.key() == ctx.accounts.payee_account.owner,
                VaultError::InboundChannelConsentRequired
            );
        }

        match ctx.accounts.payee_account.inbound_channel_policy()? {
            InboundChannelPolicy::Permissionless => {}
            InboundChannelPolicy::ConsentRequired => {
                require!(
                    ctx.accounts
                        .payee_owner
                        .as_ref()
                        .map(|payee_owner| payee_owner.key() == ctx.accounts.payee_account.owner)
                        .unwrap_or(false),
                    VaultError::InboundChannelConsentRequired
                );
            }
            InboundChannelPolicy::Disabled => {
                return Err(error!(VaultError::InboundChannelsDisabled));
            }
        }
    }

    let payer_key = ctx.accounts.payer_account.key();
    let payee_key = ctx.accounts.payee_account.key();

    ctx.accounts.payer_account.increment_open_channels()?;
    if payee_key != payer_key {
        ctx.accounts.payee_account.increment_open_channels()?;
    }

    let lane_state = &mut ctx.accounts.lane_state;
    lane_state.current_generation = lane_state
        .current_generation
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;
    lane_state.bump = ctx.bumps.lane_state;

    let channel = &mut ctx.accounts.channel_state;

    // Initialize channel with token (always new since we use init)
    channel.token_id = token_id;
    channel.payer_id = ctx.accounts.payer_account.participant_id;
    channel.payee_id = ctx.accounts.payee_account.participant_id;
    channel.settled_cumulative = 0;
    channel.close_requested_at = 0;
    channel.locked_balance = 0;
    channel.authorized_signer = authorized_signer.unwrap_or(ctx.accounts.payer_account.owner);
    channel.lane_generation = lane_state.current_generation;
    channel.bump = ctx.bumps.channel_state;

    emit!(ChannelCreated {
        payer_id: channel.payer_id,
        payee_id: channel.payee_id,
        token_id,
        lane_generation: channel.lane_generation,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct CreateChannel<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub payer_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, payee_account.owner.as_ref()],
        bump,
    )]
    pub payee_account: Account<'info, ParticipantAccount>,

    #[account(
        init,
        payer = owner,
        space = ChannelState::SPACE,
        seeds = [
            ChannelState::SEED_PREFIX,
            payer_account.participant_id.to_le_bytes().as_ref(),
            payee_account.participant_id.to_le_bytes().as_ref(),
            &token_id.to_le_bytes(), // Include token_id parameter in seeds
        ],
        bump,
    )]
    pub channel_state: Account<'info, ChannelState>,

    #[account(
        init_if_needed,
        payer = owner,
        space = LaneState::SPACE,
        seeds = [
            LaneState::SEED_PREFIX,
            payer_account.participant_id.to_le_bytes().as_ref(),
            payee_account.participant_id.to_le_bytes().as_ref(),
            &token_id.to_le_bytes(),
        ],
        bump,
    )]
    pub lane_state: Account<'info, LaneState>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub payee_owner: Option<Signer<'info>>,

    pub system_program: Program<'info, System>,
}
