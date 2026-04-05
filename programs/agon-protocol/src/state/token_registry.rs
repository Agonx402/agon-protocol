use anchor_lang::prelude::*;

use crate::errors::VaultError;

#[account]
pub struct TokenRegistry {
    /// Registry authority - can register new tokens
    pub authority: Pubkey, // 32
    /// Array of registered token entries stored inside a fixed-size account.
    pub tokens: Vec<TokenEntry>,
    /// PDA bump
    pub bump: u8, // 1
    /// Pending authority that must explicitly accept before a handoff completes.
    pub pending_authority: Pubkey, // 32
}

/// Token registry entry
/// Total: 51 bytes per entry
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TokenEntry {
    /// Unique 2-byte token identifier (0-65,535)
    pub id: u16, // 2
    /// SPL token mint address
    pub mint: Pubkey, // 32
    /// Token decimals for amount validation
    pub decimals: u8, // 1
    /// ASCII symbol (e.g., "TOK1", "TOK2") - null-terminated
    pub symbol: [u8; 8], // 8
    /// Unix timestamp when token was registered (immutable)
    pub registered_at: i64, // 8
}

impl TokenEntry {
    pub const SPACE: usize = 51;
}

impl TokenRegistry {
    pub const SEED_PREFIX: &'static [u8] = b"token-registry";
    /// Maximum decimals Agon will allowlist for a token.
    /// This keeps fee scaling in `execute_withdrawal_timelocked` inside `u64`.
    pub const MAX_TOKEN_DECIMALS: u8 = 20;

    /// Fixed account overhead: discriminator + authority + vec length + bump + pending_authority.
    pub const BASE_SPACE: usize = 8 + 32 + 4 + 1 + 32;

    /// Maximum tokens supported in a single registry account while staying
    /// within Solana's CPI account-init allocation limit (~10 KiB).
    pub const MAX_TOKENS: usize = 198;
    pub const SPACE: usize = Self::BASE_SPACE + (Self::MAX_TOKENS * TokenEntry::SPACE);

    pub fn required_space(token_count: usize) -> Result<usize> {
        let entries_space = token_count
            .checked_mul(TokenEntry::SPACE)
            .ok_or(error!(VaultError::MathOverflow))?;
        Self::BASE_SPACE
            .checked_add(entries_space)
            .ok_or(error!(VaultError::MathOverflow))
    }

    /// Find token entry by ID
    pub fn find_token(&self, token_id: u16) -> Option<&TokenEntry> {
        self.tokens.iter().find(|token| token.id == token_id)
    }

    /// Check if token ID is already registered
    pub fn is_token_registered(&self, token_id: u16) -> bool {
        self.find_token(token_id).is_some()
    }

    /// Check if mint address is already registered (prevent duplicates)
    pub fn is_mint_registered(&self, mint: &Pubkey) -> bool {
        self.tokens.iter().any(|token| token.mint == *mint)
    }

    /// Get token entry by mint address
    pub fn find_token_by_mint(&self, mint: &Pubkey) -> Option<&TokenEntry> {
        self.tokens.iter().find(|token| token.mint == *mint)
    }

    pub fn has_pending_authority(&self) -> bool {
        self.pending_authority != Pubkey::default()
    }
}
