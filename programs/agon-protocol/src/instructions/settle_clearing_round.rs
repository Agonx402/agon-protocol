use anchor_lang::prelude::*;

use crate::ed25519;
use crate::errors::VaultError;
use crate::events::ClearingRoundSettled;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount, TokenRegistry};

pub const CLEARING_ROUND_MESSAGE_KIND: u8 = 0x02;
pub const CLEARING_ROUND_MESSAGE_VERSION: u8 = 0x04;
pub const CLEARING_ROUND_FIXED_HEADER_SIZE: usize = 21;

struct ParticipantBlockMeta {
    participant_id: u32,
    entry_count: u8,
    entries_offset: usize,
}

struct ChannelEntry {
    payee_ref: u8,
    target_cumulative: u64,
}

struct ParsedClearingRoundLayout {
    token_id: u16,
    blocks: Vec<ParticipantBlockMeta>,
    channel_count: usize,
}

fn read_varint_u64(msg: &[u8], offset: &mut usize) -> Result<u64> {
    let mut shift = 0u32;
    let mut value = 0u64;

    loop {
        require!(*offset < msg.len(), VaultError::InvalidClearingRoundMessage);
        let byte = msg[*offset];
        *offset += 1;

        let chunk = (byte & 0x7f) as u64;
        if shift == 63 {
            require!(chunk <= 1, VaultError::InvalidClearingRoundMessage);
        }
        value |= chunk
            .checked_shl(shift)
            .ok_or(error!(VaultError::InvalidClearingRoundMessage))?;

        if (byte & 0x80) == 0 {
            return Ok(value);
        }

        shift = shift
            .checked_add(7)
            .ok_or(error!(VaultError::InvalidClearingRoundMessage))?;
        require!(shift < 64, VaultError::InvalidClearingRoundMessage);
    }
}

fn read_varint_u32(msg: &[u8], offset: &mut usize) -> Result<u32> {
    let value = read_varint_u64(msg, offset)?;
    require!(
        value <= u32::MAX as u64,
        VaultError::InvalidClearingRoundMessage
    );
    Ok(value as u32)
}

fn parse_clearing_round_header(
    msg: &[u8],
    global_config: &GlobalConfig,
) -> Result<(u16, u8, usize)> {
    require!(
        msg.len() >= CLEARING_ROUND_FIXED_HEADER_SIZE,
        VaultError::InvalidClearingRoundMessage
    );
    require!(
        msg[0] == CLEARING_ROUND_MESSAGE_KIND && msg[1] == CLEARING_ROUND_MESSAGE_VERSION,
        VaultError::InvalidClearingRoundMessage
    );
    require!(
        msg[2..18] == global_config.message_domain,
        VaultError::InvalidMessageDomain
    );

    let token_id = u16::from_le_bytes(msg[18..20].try_into().unwrap());
    let participant_count = msg[20];
    require!(
        participant_count > 0,
        VaultError::InvalidClearingRoundMessage
    );

    Ok((
        token_id,
        participant_count,
        CLEARING_ROUND_FIXED_HEADER_SIZE,
    ))
}

fn parse_channel_entry(msg: &[u8], offset: &mut usize) -> Result<ChannelEntry> {
    require!(*offset < msg.len(), VaultError::InvalidClearingRoundMessage);
    let payee_ref = msg[*offset];
    *offset += 1;
    let target_cumulative = read_varint_u64(msg, offset)?;

    Ok(ChannelEntry {
        payee_ref,
        target_cumulative,
    })
}

fn parse_clearing_round_layout(
    msg: &[u8],
    global_config: &GlobalConfig,
) -> Result<ParsedClearingRoundLayout> {
    let (token_id, participant_count, mut offset) =
        parse_clearing_round_header(msg, global_config)?;
    let mut blocks = Vec::with_capacity(participant_count as usize);
    let mut channel_count = 0usize;

    for _ in 0..participant_count {
        let participant_id = read_varint_u32(msg, &mut offset)?;
        require!(offset < msg.len(), VaultError::InvalidClearingRoundMessage);
        let entry_count = msg[offset];
        offset += 1;
        let entries_offset = offset;

        for _ in 0..entry_count {
            let _ = parse_channel_entry(msg, &mut offset)?;
            channel_count += 1;
        }

        blocks.push(ParticipantBlockMeta {
            participant_id,
            entry_count,
            entries_offset,
        });
    }

    require!(offset == msg.len(), VaultError::InvalidClearingRoundMessage);
    Ok(ParsedClearingRoundLayout {
        token_id,
        blocks,
        channel_count,
    })
}

struct ChannelUpdate {
    channel_account_index: usize,
    target_cumulative: u64,
    locked_consumed: u64,
}

struct ParticipantSnapshot {
    participant_id: u32,
    token_total_balance: u64,
}

fn add_position(positions: &mut Vec<(u32, i128)>, participant_id: u32, delta: i128) -> Result<()> {
    if let Some((_, position)) = positions.iter_mut().find(|(pid, _)| *pid == participant_id) {
        *position = position
            .checked_add(delta)
            .ok_or(error!(VaultError::NetPositionOverflow))?;
    } else {
        positions.push((participant_id, delta));
    }
    Ok(())
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleClearingRound<'info>>,
) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;

    let verified_message =
        ed25519::verify_and_extract_all_signatures(&ctx.accounts.instructions_sysvar, 0)?;
    let message = verified_message.message();
    let parsed = parse_clearing_round_layout(message, &ctx.accounts.global_config)?;

    ctx.accounts
        .token_registry
        .find_token(parsed.token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let remaining = &ctx.remaining_accounts;
    let participant_count = parsed.blocks.len();
    require!(
        remaining.len() == participant_count + parsed.channel_count,
        VaultError::InvalidClearingRoundMessage
    );
    require!(
        verified_message.signers.len() == participant_count,
        VaultError::InvalidSignature
    );

    let mut signer_used = vec![false; verified_message.signers.len()];
    let mut block_participant_ids = Vec::with_capacity(participant_count);
    let mut seen_channel_accounts = Vec::with_capacity(parsed.channel_count);
    let mut channel_updates = Vec::with_capacity(parsed.channel_count);
    let mut positions: Vec<(u32, i128)> = Vec::with_capacity(participant_count * 2);
    let mut participant_snapshots = Vec::with_capacity(participant_count);
    let mut total_gross: u64 = 0;
    let mut channel_account_index = participant_count;

    for block in &parsed.blocks {
        require!(
            !block_participant_ids.contains(&block.participant_id),
            VaultError::InvalidClearingRoundMessage
        );
        block_participant_ids.push(block.participant_id);
    }

    for (block_index, block) in parsed.blocks.iter().enumerate() {
        let participant_info = &remaining[block_index];
        require!(
            participant_info.owner == program_id,
            VaultError::ParticipantNotFound
        );
        let participant_data = participant_info.try_borrow_data()?;
        let (owner, participant_id, bump) =
            ParticipantAccount::read_owner_id_and_bump(participant_data.as_ref())?;
        ParticipantAccount::verify_pda_from_raw_fields(
            participant_info.key,
            &owner,
            bump,
            program_id,
        )?;
        let token_total_balance = ParticipantAccount::read_token_total_balance_or_zero_from_data(
            participant_data.as_ref(),
            parsed.token_id,
        )?;
        drop(participant_data);
        require!(
            participant_id == block.participant_id,
            VaultError::AccountIdMismatch
        );
        participant_snapshots.push(ParticipantSnapshot {
            participant_id,
            token_total_balance,
        });

        let mut found_signer = false;
        for (signer_index, signer) in verified_message.signers.iter().enumerate() {
            if !signer_used[signer_index] && *signer == owner {
                signer_used[signer_index] = true;
                found_signer = true;
                break;
            }
        }
        require!(found_signer, VaultError::InvalidSignature);
    }

    for block in &parsed.blocks {
        let mut entry_offset = block.entries_offset;
        for _ in 0..block.entry_count {
            let entry = parse_channel_entry(message, &mut entry_offset)?;

            let channel_info = &remaining[channel_account_index];
            require!(
                channel_info.owner == program_id,
                VaultError::ChannelNotInitialized
            );
            require!(
                !seen_channel_accounts.contains(channel_info.key),
                VaultError::InvalidClearingRoundMessage
            );
            seen_channel_accounts.push(*channel_info.key);

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
                channel.payer_id == block.participant_id,
                VaultError::AccountIdMismatch
            );
            require!(
                channel.token_id == parsed.token_id,
                VaultError::InvalidTokenMint
            );
            require!(
                (entry.payee_ref as usize) < block_participant_ids.len(),
                VaultError::InvalidClearingRoundMessage
            );
            require!(
                channel.payee_id == block_participant_ids[entry.payee_ref as usize],
                VaultError::AccountIdMismatch
            );
            require!(
                entry.target_cumulative > channel.settled_cumulative,
                VaultError::CommitmentAmountMustIncrease
            );

            let delta = entry
                .target_cumulative
                .checked_sub(channel.settled_cumulative)
                .ok_or(error!(VaultError::MathOverflow))?;
            let locked_consumed = channel.locked_balance.min(delta);
            let uncovered_delta = delta
                .checked_sub(locked_consumed)
                .ok_or(error!(VaultError::MathOverflow))?;

            add_position(
                &mut positions,
                block.participant_id,
                -(uncovered_delta as i128),
            )?;
            add_position(&mut positions, channel.payee_id, delta as i128)?;

            total_gross = total_gross
                .checked_add(delta)
                .ok_or(error!(VaultError::MathOverflow))?;

            channel_updates.push(ChannelUpdate {
                channel_account_index,
                target_cumulative: entry.target_cumulative,
                locked_consumed,
            });
            channel_account_index += 1;
        }
    }

    require!(
        signer_used.into_iter().all(|used| used),
        VaultError::InvalidSignature
    );

    for (participant_id, position) in &positions {
        if *position != 0 {
            require!(
                block_participant_ids.contains(participant_id),
                VaultError::InvalidClearingRoundMessage
            );
        }
    }

    for (participant_id, position) in &positions {
        if *position < 0 {
            let abs_position = (-*position) as u64;
            let snapshot = participant_snapshots
                .iter()
                .find(|snapshot| snapshot.participant_id == *participant_id)
                .ok_or(error!(VaultError::ParticipantNotFound))?;
            require!(
                snapshot.token_total_balance >= abs_position,
                VaultError::InsufficientBalance
            );
        }
    }

    for update in &channel_updates {
        let channel_info = &remaining[update.channel_account_index];
        let mut channel_data = channel_info.try_borrow_mut_data()?;
        let mut channel = ChannelState::try_deserialize(&mut channel_data.as_ref())?;
        channel.locked_balance -= update.locked_consumed;
        channel.settled_cumulative = update.target_cumulative;
        channel.try_serialize(&mut channel_data.as_mut())?;
    }

    for (block_index, block) in parsed.blocks.iter().enumerate() {
        let Some((_, position)) = positions
            .iter()
            .find(|(pid, _)| *pid == block.participant_id)
        else {
            continue;
        };

        if *position == 0 {
            continue;
        }

        let participant_info = &remaining[block_index];
        let mut participant_data = participant_info.try_borrow_mut_data()?;
        let mut participant = ParticipantAccount::try_deserialize(&mut participant_data.as_ref())?;

        if *position > 0 {
            participant.credit_token(parsed.token_id, *position as u64)?;
        } else {
            participant.debit_token(parsed.token_id, (-*position) as u64)?;
        }

        participant.try_serialize(&mut participant_data.as_mut())?;
    }

    let total_net_adjusted = positions
        .iter()
        .filter_map(|(_, position)| (*position > 0).then_some(*position as u64))
        .try_fold(0u64, |acc, value| acc.checked_add(value))
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(ClearingRoundSettled {
        token_id: parsed.token_id,
        participant_count: participant_count as u16,
        channel_count: parsed.channel_count as u16,
        total_gross,
        total_net_adjusted,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleClearingRound<'info> {
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
    pub submitter: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 and CPI verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::GlobalConfig;
    use proptest::prelude::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn test_global_config(message_domain: [u8; 16]) -> GlobalConfig {
        GlobalConfig {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            fee_bps: 0,
            withdrawal_timelock_seconds: 0,
            registration_fee_lamports: 0,
            next_participant_id: 1,
            bump: 0,
            chain_id: GlobalConfig::DEVNET_CHAIN_ID,
            message_domain,
            pending_authority: Pubkey::default(),
            _reserved: [0u8; 14],
        }
    }

    fn encode_varint_u64(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
        out
    }

    fn encode_varint_u32(value: u32) -> Vec<u8> {
        encode_varint_u64(value as u64)
    }

    fn build_clearing_round_message_bytes(
        message_domain: [u8; 16],
        token_id: u16,
        blocks: &[(u32, Vec<(u8, u64)>)],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(CLEARING_ROUND_MESSAGE_KIND);
        out.push(CLEARING_ROUND_MESSAGE_VERSION);
        out.extend_from_slice(&message_domain);
        out.extend_from_slice(&token_id.to_le_bytes());
        out.push(blocks.len() as u8);
        for (participant_id, entries) in blocks {
            out.extend_from_slice(&encode_varint_u32(*participant_id));
            out.push(entries.len() as u8);
            for (payee_ref, target_cumulative) in entries {
                out.push(*payee_ref);
                out.extend_from_slice(&encode_varint_u64(*target_cumulative));
            }
        }
        out
    }

    fn blocks_strategy() -> impl Strategy<Value = Vec<(u32, Vec<(u8, u64)>)>> {
        (1usize..=5).prop_flat_map(|participant_count| {
            prop::collection::vec(
                (
                    1u32..=10_000u32,
                    prop::collection::vec(
                        (0u8..participant_count as u8, 1u64..=1_000_000u64),
                        0..=3,
                    ),
                ),
                participant_count,
            )
            .prop_filter("participant ids must be unique", |blocks| {
                let ids: BTreeSet<_> = blocks
                    .iter()
                    .map(|(participant_id, _)| *participant_id)
                    .collect();
                ids.len() == blocks.len()
            })
        })
    }

    proptest! {
        #[test]
        fn clearing_round_layout_round_trips_random_v4_blocks(
            token_id in any::<u16>(),
            message_domain in any::<[u8; 16]>(),
            blocks in blocks_strategy(),
        ) {
            let config = test_global_config(message_domain);
            let message = build_clearing_round_message_bytes(message_domain, token_id, &blocks);
            let parsed = parse_clearing_round_layout(&message, &config).unwrap();

            prop_assert_eq!(parsed.token_id, token_id);
            prop_assert_eq!(parsed.blocks.len(), blocks.len());
            prop_assert_eq!(
                parsed.channel_count,
                blocks.iter().map(|(_, entries)| entries.len()).sum::<usize>()
            );

            for (index, block) in parsed.blocks.iter().enumerate() {
                prop_assert_eq!(block.participant_id, blocks[index].0);
                prop_assert_eq!(block.entry_count as usize, blocks[index].1.len());
            }
        }

        #[test]
        fn clearing_round_position_aggregation_matches_naive_netting(
            participant_count in 3u8..=6u8,
            edges in prop::collection::vec(
                (0u8..6u8, 0u8..6u8, 1u64..=250_000u64, 0u64..=250_000u64),
                1..=16
            )
        ) {
            let filtered_edges: Vec<_> = edges
                .into_iter()
                .filter(|(payer, payee, _, _)| payer < &participant_count && payee < &participant_count && payer != payee)
                .collect();
            prop_assume!(!filtered_edges.is_empty());

            let mut positions: Vec<(u32, i128)> = Vec::new();
            let mut naive_positions = BTreeMap::<u32, i128>::new();
            let mut total_locked_before = 0u128;
            let mut total_locked_after = 0u128;

            for (payer, payee, delta, locked_balance) in filtered_edges {
                let locked_consumed = locked_balance.min(delta);
                let uncovered_delta = delta - locked_consumed;
                let payer_id = payer as u32 + 1;
                let payee_id = payee as u32 + 1;

                add_position(&mut positions, payer_id, -(uncovered_delta as i128)).unwrap();
                add_position(&mut positions, payee_id, delta as i128).unwrap();

                *naive_positions.entry(payer_id).or_insert(0) -= uncovered_delta as i128;
                *naive_positions.entry(payee_id).or_insert(0) += delta as i128;

                total_locked_before += locked_balance as u128;
                total_locked_after += (locked_balance - locked_consumed) as u128;
            }

            for (participant_id, expected_position) in naive_positions {
                let actual = positions
                    .iter()
                    .find(|(candidate_id, _)| *candidate_id == participant_id)
                    .map(|(_, amount)| *amount)
                    .unwrap_or(0);
                prop_assert_eq!(actual, expected_position);
            }

            let participant_delta_sum: i128 =
                positions.iter().map(|(_, amount)| *amount).sum();
            prop_assert_eq!(
                participant_delta_sum as u128,
                total_locked_before - total_locked_after
            );
            prop_assert_eq!(
                total_locked_before,
                total_locked_after + participant_delta_sum as u128
            );
        }
    }

    #[test]
    fn clearing_round_header_rejects_zero_participants() {
        let message_domain = [9u8; 16];
        let config = test_global_config(message_domain);
        let mut message = Vec::new();
        message.push(CLEARING_ROUND_MESSAGE_KIND);
        message.push(CLEARING_ROUND_MESSAGE_VERSION);
        message.extend_from_slice(&message_domain);
        message.extend_from_slice(&1u16.to_le_bytes());
        message.push(0);

        assert!(parse_clearing_round_layout(&message, &config).is_err());
    }
}
