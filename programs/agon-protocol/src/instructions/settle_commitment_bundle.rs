use anchor_lang::prelude::*;

use crate::balance_deltas::{
    add_balance_delta, apply_balance_delta, find_balance_delta, ParticipantBalanceDelta,
};
use crate::ed25519;
use crate::errors::VaultError;
use crate::events::CommitmentBundleSettled;
use crate::instructions::settle_individual::parse_commitment_message;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount, TokenRegistry};

struct BundleEntry {
    payer_id: u32,
    payer_index: usize,
    channel_index: usize,
    committed_amount: u64,
    locked_consumed: u64,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleCommitmentBundle<'info>>,
    count: u8,
) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;
    require!(count > 0, VaultError::InvalidCommitmentMessage);

    let ix_data = ed25519::verify_ed25519_ix(&ctx.accounts.instructions_sysvar, 0)?;
    require!(
        ix_data.first().copied() == Some(count),
        VaultError::InvalidCommitmentMessage
    );
    let remaining = &ctx.remaining_accounts;
    let payee = &mut ctx.accounts.payee_account;
    let submitter = ctx.accounts.submitter.key();

    let mut token_id: Option<u16> = None;
    let mut total: u64 = 0;
    let mut seen_channel_accounts = Vec::with_capacity(count as usize);
    let mut bundle_entries = Vec::with_capacity(count as usize);
    let mut balance_deltas: Vec<ParticipantBalanceDelta> = Vec::with_capacity((count as usize) + 1);
    require!(
        remaining.len() == count as usize * 2,
        VaultError::InvalidCommitmentMessage
    );

    for i in 0..count as usize {
        let offsets = ed25519::parse_ed25519_offsets(&ix_data, i as u16)?;
        let signer_pubkey = ed25519::extract_pubkey(&ix_data, &offsets)?;
        let message = ed25519::extract_message(&ix_data, &offsets)?;

        let parsed = parse_commitment_message(&message, &ctx.accounts.global_config)?;

        ctx.accounts
            .token_registry
            .find_token(parsed.token_id)
            .ok_or(VaultError::TokenNotFound)?;

        match token_id {
            Some(existing) => require!(
                existing == parsed.token_id,
                VaultError::InvalidCommitmentMessage
            ),
            None => token_id = Some(parsed.token_id),
        }

        let submitter_ok = submitter == payee.owner
            || parsed
                .authorized_settler
                .map(|settler| settler == submitter)
                .unwrap_or(false);
        require!(submitter_ok, VaultError::UnauthorizedSettler);

        let payer_index = i * 2;
        let channel_index = (i * 2) + 1;
        let payer_info = &remaining[payer_index];
        let channel_info = &remaining[channel_index];

        require!(
            payer_info.owner == program_id,
            VaultError::ParticipantNotFound
        );
        ParticipantAccount::verify_pda(payer_info, program_id)?;
        require!(
            channel_info.owner == program_id,
            VaultError::ChannelNotInitialized
        );

        let payer_data = payer_info.try_borrow_data()?;
        let payer_account = ParticipantAccount::try_deserialize(&mut payer_data.as_ref())?;
        drop(payer_data);

        let channel_data = channel_info.try_borrow_data()?;
        let channel = ChannelState::try_deserialize(&mut channel_data.as_ref())?;
        drop(channel_data);
        ChannelState::verify_expected_pda(
            channel_info.key,
            channel.payer_id,
            channel.payee_id,
            channel.token_id,
            channel.bump,
            program_id,
        )?;

        require!(
            signer_pubkey == channel.authorized_signer,
            VaultError::InvalidSignature
        );
        require!(
            !seen_channel_accounts.contains(channel_info.key),
            VaultError::InvalidCommitmentMessage
        );
        seen_channel_accounts.push(*channel_info.key);
        require!(
            channel.payer_id == parsed.payer_id,
            VaultError::AccountIdMismatch
        );
        require!(
            channel.payee_id == parsed.payee_id,
            VaultError::AccountIdMismatch
        );
        require!(
            channel.token_id == parsed.token_id,
            VaultError::InvalidTokenMint
        );
        require!(
            channel.payee_id == payee.participant_id,
            VaultError::AccountIdMismatch
        );
        require!(
            channel.payer_id == payer_account.participant_id,
            VaultError::AccountIdMismatch
        );
        require!(
            parsed.committed_amount > channel.settled_cumulative,
            VaultError::CommitmentAmountMustIncrease
        );

        let amount = parsed
            .committed_amount
            .checked_sub(channel.settled_cumulative)
            .ok_or(error!(VaultError::MathOverflow))?;
        let total_available = channel
            .locked_balance
            .checked_add(payer_account.get_token_total_balance(parsed.token_id)?)
            .ok_or(error!(VaultError::MathOverflow))?;
        require!(total_available >= amount, VaultError::InsufficientBalance);

        let locked_consumed = channel.locked_balance.min(amount);
        let shared_debit = amount
            .checked_sub(locked_consumed)
            .ok_or(error!(VaultError::MathOverflow))?;

        total = total
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;

        add_balance_delta(
            &mut balance_deltas,
            parsed.payer_id,
            -(shared_debit as i128),
        )?;
        add_balance_delta(&mut balance_deltas, parsed.payee_id, amount as i128)?;

        bundle_entries.push(BundleEntry {
            payer_id: parsed.payer_id,
            payer_index,
            channel_index,
            committed_amount: parsed.committed_amount,
            locked_consumed,
        });
    }

    let batch_token_id = token_id.ok_or(error!(VaultError::InvalidCommitmentMessage))?;
    let payee_id = payee.participant_id;

    for entry in &bundle_entries {
        let mut payer_data = remaining[entry.payer_index].try_borrow_mut_data()?;
        let mut payer_account = ParticipantAccount::try_deserialize(&mut payer_data.as_ref())?;

        let mut channel_data = remaining[entry.channel_index].try_borrow_mut_data()?;
        let mut channel = ChannelState::try_deserialize(&mut channel_data.as_ref())?;

        channel.settled_cumulative = entry.committed_amount;
        channel.locked_balance -= entry.locked_consumed;
        if entry.payer_id != payee_id {
            apply_balance_delta(
                &mut payer_account,
                batch_token_id,
                find_balance_delta(&balance_deltas, entry.payer_id),
            )?;
        }

        payer_account.try_serialize(&mut payer_data.as_mut())?;
        channel.try_serialize(&mut channel_data.as_mut())?;
    }

    apply_balance_delta(
        payee,
        batch_token_id,
        find_balance_delta(&balance_deltas, payee_id),
    )?;

    emit!(CommitmentBundleSettled {
        payee_id: payee.participant_id,
        token_id: batch_token_id,
        channel_count: bundle_entries.len() as u16,
        total,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleCommitmentBundle<'info> {
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

    #[account(mut)]
    pub payee_account: Account<'info, ParticipantAccount>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 and CPI verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[derive(Clone, Debug)]
    struct BundleModelEntry {
        payer_id: u32,
        amount: u64,
        locked_balance: u64,
        shared_balance: u64,
    }

    proptest! {
        #[test]
        fn bundle_settlement_preserves_total_value_and_payee_gain(
            payee_starting_balance in 0u64..=1_000_000u64,
            raw_entries in prop::collection::vec(
                (1u64..=250_000u64, 0u64..=250_000u64, 0u64..=250_000u64),
                1..=6
            )
        ) {
            let entries: Vec<BundleModelEntry> = raw_entries
                .into_iter()
                .enumerate()
                .map(|(index, (amount, locked_balance, shared_balance))| BundleModelEntry {
                    payer_id: (index + 1) as u32,
                    amount,
                    locked_balance,
                    shared_balance,
                })
                .collect();

            prop_assume!(entries.iter().all(|entry| {
                entry
                    .locked_balance
                    .checked_add(entry.shared_balance)
                    .map(|available| available >= entry.amount)
                    .unwrap_or(false)
            }));

            let mut balance_deltas: Vec<ParticipantBalanceDelta> = Vec::new();
            let before_total = payee_starting_balance as u128
                + entries
                    .iter()
                    .map(|entry| entry.locked_balance as u128 + entry.shared_balance as u128)
                    .sum::<u128>();
            let mut after_locked_total = 0u128;
            let mut expected_payee_gain = 0u64;

            for entry in &entries {
                let locked_consumed = entry.locked_balance.min(entry.amount);
                let shared_debit = entry.amount - locked_consumed;

                after_locked_total += (entry.locked_balance - locked_consumed) as u128;
                expected_payee_gain += entry.amount;

                add_balance_delta(
                    &mut balance_deltas,
                    entry.payer_id,
                    -(shared_debit as i128),
                ).unwrap();
                add_balance_delta(&mut balance_deltas, 55, entry.amount as i128).unwrap();
            }

            let participant_delta_sum: i128 =
                balance_deltas.iter().map(|delta| delta.amount_delta).sum();
            let after_total = after_locked_total
                + (payee_starting_balance as i128 + find_balance_delta(&balance_deltas, 55)) as u128
                + entries
                    .iter()
                    .map(|entry| {
                        (entry.shared_balance as i128
                            + find_balance_delta(&balance_deltas, entry.payer_id))
                            as u128
                    })
                    .sum::<u128>();

            prop_assert_eq!(
                participant_delta_sum as u128,
                before_total
                    - after_locked_total
                    - entries
                        .iter()
                        .map(|entry| entry.shared_balance as u128)
                        .sum::<u128>()
                    - payee_starting_balance as u128
            );
            prop_assert_eq!(find_balance_delta(&balance_deltas, 55), expected_payee_gain as i128);
            prop_assert_eq!(before_total, after_total);
        }
    }
}
