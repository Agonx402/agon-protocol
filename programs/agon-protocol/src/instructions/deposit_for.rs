use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::events::Deposited;
use crate::state::{GlobalConfig, ParticipantAccount, TokenRegistry};

/// Max participants per batch (tx size / account limits)
pub const MAX_DEPOSIT_FOR_RECIPIENTS: usize = 16;

pub fn handler(ctx: Context<DepositFor>, token_id: u16, amounts: Vec<u64>) -> Result<()> {
    let remaining = &ctx.remaining_accounts;
    require!(
        !amounts.is_empty() && amounts.len() == remaining.len(),
        crate::errors::VaultError::InvalidDepositFor
    );
    require!(
        amounts.len() <= MAX_DEPOSIT_FOR_RECIPIENTS,
        crate::errors::VaultError::InvalidDepositFor
    );

    // Validate token is registered
    let token_entry = ctx
        .accounts
        .token_registry
        .find_token(token_id)
        .ok_or(crate::errors::VaultError::TokenNotFound)?;

    // Validate funder token account matches registered token
    require!(
        ctx.accounts.funder_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );

    // Validate vault token account matches registered token
    require!(
        ctx.accounts.vault_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );

    let total: u64 = amounts
        .iter()
        .try_fold(0u64, |acc, &a| acc.checked_add(a))
        .ok_or(error!(crate::errors::VaultError::MathOverflow))?;

    require!(total > 0, crate::errors::VaultError::AmountMustBePositive);

    // Transfer total from funder's ATA to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        total,
    )?;

    // Credit each participant using manual account data manipulation
    // to avoid lifetime issues with remaining_accounts deserialization
    for (i, amount) in amounts.iter().enumerate() {
        require!(*amount > 0, crate::errors::VaultError::AmountMustBePositive);

        // Get participant account from remaining_accounts
        let participant_info = &remaining[i];

        // Verify ownership (ParticipantAccount should be owned by our program)
        require!(
            participant_info.owner == ctx.program_id,
            crate::errors::VaultError::ParticipantNotFound
        );
        ParticipantAccount::verify_pda(participant_info, ctx.program_id)?;

        // Manually modify the participant account data to avoid lifetime issues
        let mut participant_data = participant_info.try_borrow_mut_data()?;
        let mut participant = ParticipantAccount::try_deserialize(&mut participant_data.as_ref())?;

        // Credit the participant with the specific token
        participant.credit_token(token_id, *amount)?;

        // Serialize back to the account
        participant.try_serialize(&mut participant_data.as_mut())?;

        emit!(Deposited {
            participant_id: participant.participant_id,
            token_id,
            amount: *amount,
        });
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct DepositFor<'info> {
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
        constraint = funder_token_account.owner == funder.key(),
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
