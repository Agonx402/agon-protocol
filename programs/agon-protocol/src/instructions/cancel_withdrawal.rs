use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::WithdrawalCancelled;
use crate::state::ParticipantAccount;

pub fn handler(ctx: Context<CancelWithdrawal>, token_id: u16) -> Result<()> {
    let participant = &mut ctx.accounts.participant_account;

    // Get token balance and validate withdrawal is pending
    let token_balance = participant.get_token_balance_mut(token_id)?;

    require!(
        token_balance.withdrawal_unlock_at != 0,
        VaultError::NoWithdrawalPending
    );

    let amount_returned = token_balance.withdrawing_balance;

    // Move withdrawing back to available
    token_balance.available_balance = token_balance
        .available_balance
        .checked_add(token_balance.withdrawing_balance)
        .ok_or(error!(VaultError::MathOverflow))?;
    token_balance.withdrawing_balance = 0;
    token_balance.withdrawal_unlock_at = 0;
    token_balance.withdrawal_destination = Pubkey::default();

    emit!(WithdrawalCancelled {
        participant_id: participant.participant_id,
        token_id,
        amount_returned,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelWithdrawal<'info> {
    #[account(
        mut,
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,

    pub owner: Signer<'info>,
}
