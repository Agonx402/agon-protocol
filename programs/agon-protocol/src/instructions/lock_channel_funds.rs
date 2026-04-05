use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelFundsLocked;
use crate::state::{ChannelState, ParticipantAccount, TokenRegistry};

pub fn handler(ctx: Context<LockChannelFunds>, token_id: u16, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);

    let payer = &mut ctx.accounts.payer_account;
    let channel = &mut ctx.accounts.channel_state;

    // Validate token matches channel
    require!(channel.token_id == token_id, VaultError::InvalidTokenMint);

    // Check token-specific balance
    let payer_token_balance = payer
        .get_token_balance(token_id)
        .ok_or(VaultError::TokenNotFound)?;
    require!(
        payer_token_balance.available_balance >= amount,
        VaultError::InsufficientBalance
    );

    // Debit from available, credit to locked
    payer.debit_token(token_id, amount)?;
    channel.locked_balance = channel
        .locked_balance
        .checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(ChannelFundsLocked {
        payer_id: payer.participant_id,
        payee_id: ctx.accounts.payee_account.participant_id,
        token_id,
        amount,
        total_locked: channel.locked_balance,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct LockChannelFunds<'info> {
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

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}
