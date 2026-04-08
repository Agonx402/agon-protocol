use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::events::ParticipantInitialized;
use crate::state::{GlobalConfig, ParticipantAccount};

pub fn handler(ctx: Context<InitializeParticipant>) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    let participant = &mut ctx.accounts.participant_account;

    // Transfer registration fee if non-zero
    if config.registration_fee_lamports > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            config.registration_fee_lamports,
        )?;
    }

    // Initialize participant
    participant.owner = ctx.accounts.owner.key();
    participant.participant_id = config.next_participant_id;
    participant.token_balances = Vec::new(); // Start with empty token balances
    participant.bump = ctx.bumps.participant_account;
    participant.inbound_channel_policy = ParticipantAccount::DEFAULT_INBOUND_CHANNEL_POLICY;
    participant._reserved = [0u8; 7];

    // Increment global counter
    config.next_participant_id = config
        .next_participant_id
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(ParticipantInitialized {
        owner: participant.owner,
        participant_id: participant.participant_id,
        registration_fee_lamports: config.registration_fee_lamports,
        inbound_channel_policy: participant.inbound_channel_policy,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeParticipant<'info> {
    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = owner,
        space = ParticipantAccount::SPACE,
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        constraint = fee_recipient.key() == global_config.fee_recipient @ VaultError::InvalidFeeRecipient,
    )]
    pub fee_recipient: SystemAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}
