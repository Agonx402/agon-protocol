use anchor_lang::prelude::*;

use crate::events::InboundChannelPolicyUpdated;
use crate::state::{InboundChannelPolicy, ParticipantAccount};

pub fn handler(ctx: Context<UpdateInboundChannelPolicy>, inbound_channel_policy: u8) -> Result<()> {
    let policy = InboundChannelPolicy::try_from(inbound_channel_policy)?;
    let participant = &mut ctx.accounts.participant_account;
    participant.set_inbound_channel_policy(policy);

    emit!(InboundChannelPolicyUpdated {
        participant_id: participant.participant_id,
        inbound_channel_policy,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateInboundChannelPolicy<'info> {
    #[account(
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,

    pub owner: Signer<'info>,
}
