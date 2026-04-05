use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ParticipantClosed;
use crate::state::ParticipantAccount;

pub fn handler(ctx: Context<CloseParticipant>) -> Result<()> {
    let participant = &ctx.accounts.participant_account;

    require!(
        participant.open_channel_count() == 0,
        VaultError::OpenChannelsExist
    );

    // Must have zero balances in ALL tokens — withdraw or settle commitments first
    for token_balance in &participant.token_balances {
        require!(
            token_balance.available_balance == 0,
            VaultError::BalanceMustBeZeroToClose
        );
        require!(
            token_balance.withdrawing_balance == 0,
            VaultError::BalanceMustBeZeroToClose
        );
        require!(
            token_balance.withdrawal_unlock_at == 0,
            VaultError::WithdrawalMustBeClearedToClose
        );
    }

    emit!(ParticipantClosed {
        participant_id: participant.participant_id,
        owner: participant.owner,
    });

    // Account is closed via the `close` attribute in Accounts struct
    Ok(())
}

#[derive(Accounts)]
pub struct CloseParticipant<'info> {
    #[account(
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
        close = owner,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
}
