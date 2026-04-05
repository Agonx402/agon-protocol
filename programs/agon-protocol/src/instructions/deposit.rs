use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::events::Deposited;
use crate::state::{GlobalConfig, ParticipantAccount, TokenRegistry};

pub fn handler(ctx: Context<Deposit>, token_id: u16, amount: u64) -> Result<()> {
    require!(amount > 0, crate::errors::VaultError::AmountMustBePositive);

    // Validate token is registered and get mint address
    let registry = &ctx.accounts.token_registry;
    let token_entry = registry
        .find_token(token_id)
        .ok_or(crate::errors::VaultError::TokenNotFound)?;

    // Verify the provided accounts match the registered token
    require!(
        ctx.accounts.owner_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );
    require!(
        ctx.accounts.vault_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );

    // CPI: transfer tokens from owner's ATA to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    // Credit participant with token-specific balance
    let participant = &mut ctx.accounts.participant_account;
    participant.credit_token(token_id, amount)?;

    emit!(Deposited {
        participant_id: participant.participant_id,
        token_id,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct Deposit<'info> {
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

    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
