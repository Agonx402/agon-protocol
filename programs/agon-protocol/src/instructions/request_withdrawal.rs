use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::WithdrawalRequested;
use crate::state::{GlobalConfig, ParticipantAccount, TokenRegistry};

pub fn handler(
    ctx: Context<RequestWithdrawal>,
    token_id: u16,
    amount: u64,
    destination: Pubkey,
) -> Result<()> {
    let participant = &mut ctx.accounts.participant_account;
    let config = &ctx.accounts.global_config;

    // Validate token is registered
    let token_entry = ctx
        .accounts
        .token_registry
        .find_token(token_id)
        .ok_or(VaultError::TokenNotFound)?;

    require!(amount > 0, VaultError::AmountMustBePositive);

    // Destination must not be zero. Can be participant's own or any 3rd party token account.
    require!(
        destination != Pubkey::default(),
        VaultError::InvalidWithdrawalDestination
    );
    require!(
        destination == ctx.accounts.withdrawal_destination.key(),
        VaultError::InvalidWithdrawalDestination
    );

    // Check that destination account has the correct mint
    require!(
        ctx.accounts.withdrawal_destination.mint == token_entry.mint,
        VaultError::InvalidTokenMint
    );

    // Check that no withdrawal is already pending for this token
    let token_balance = participant
        .get_token_balance(token_id)
        .ok_or(VaultError::TokenNotFound)?;
    require!(
        token_balance.withdrawal_unlock_at == 0,
        VaultError::WithdrawalAlreadyPending
    );

    // Move from available to withdrawing for this token
    participant.initiate_token_withdrawal(token_id, amount, destination, 0)?;

    // Set the unlock time
    let clock = Clock::get()?;
    let token_balance_mut = participant.get_token_balance_mut(token_id).unwrap();
    token_balance_mut.withdrawal_unlock_at = clock
        .unix_timestamp
        .checked_add(config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;

    let unlock_at = token_balance_mut.withdrawal_unlock_at;

    emit!(WithdrawalRequested {
        participant_id: participant.participant_id,
        token_id,
        amount,
        destination,
        unlock_at,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
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
        seeds = [ParticipantAccount::SEED_PREFIX, owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,

    /// The withdrawal destination token account
    #[account(
        constraint = withdrawal_destination.owner != Pubkey::default(),
    )]
    pub withdrawal_destination: Account<'info, anchor_spl::token::TokenAccount>,

    pub owner: Signer<'info>,
}
