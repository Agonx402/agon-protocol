use anchor_lang::prelude::*;

use crate::balance_deltas::{
    add_balance_delta, apply_balance_delta, apply_balance_delta_to_account_info,
    find_balance_delta, ParticipantBalanceDelta,
};
use crate::ed25519;
use crate::errors::VaultError;
use crate::events::IndividualSettled;
use crate::state::{ChannelState, GlobalConfig, ParticipantAccount, TokenRegistry};

pub const COMMITMENT_MESSAGE_KIND: u8 = 0x01;
pub const COMMITMENT_MESSAGE_VERSION: u8 = 0x03;
pub const COMMITMENT_FLAG_AUTHORIZED_SETTLER: u8 = 1 << 0;
pub const COMMITMENT_FLAG_FEE: u8 = 1 << 1;
pub const COMMITMENT_FIXED_HEADER_SIZE: usize = 19;
pub const COMMITMENT_MIN_MSG_SIZE: usize = 25;

pub struct ParsedCommitmentMessage {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub lane_generation: u32,
    pub committed_amount: u64,
    pub authorized_settler: Option<Pubkey>,
    pub fee_amount: u64,
    pub fee_recipient_id: u32,
}

fn read_varint_u64(msg: &[u8], offset: &mut usize) -> Result<u64> {
    let mut shift = 0u32;
    let mut value = 0u64;

    loop {
        require!(*offset < msg.len(), VaultError::InvalidCommitmentMessage);
        let byte = msg[*offset];
        *offset += 1;

        let chunk = (byte & 0x7f) as u64;
        if shift == 63 {
            require!(chunk <= 1, VaultError::InvalidCommitmentMessage);
        }
        value |= chunk
            .checked_shl(shift)
            .ok_or(error!(VaultError::InvalidCommitmentMessage))?;

        if (byte & 0x80) == 0 {
            return Ok(value);
        }

        shift = shift
            .checked_add(7)
            .ok_or(error!(VaultError::InvalidCommitmentMessage))?;
        require!(shift < 64, VaultError::InvalidCommitmentMessage);
    }
}

fn read_varint_u32(msg: &[u8], offset: &mut usize) -> Result<u32> {
    let value = read_varint_u64(msg, offset)?;
    require!(
        value <= u32::MAX as u64,
        VaultError::InvalidCommitmentMessage
    );
    Ok(value as u32)
}

pub fn parse_commitment_message(
    msg: &[u8],
    global_config: &GlobalConfig,
) -> Result<ParsedCommitmentMessage> {
    require!(
        msg.len() >= COMMITMENT_MIN_MSG_SIZE,
        VaultError::InvalidCommitmentMessage
    );
    require!(
        msg[0] == COMMITMENT_MESSAGE_KIND && msg[1] == COMMITMENT_MESSAGE_VERSION,
        VaultError::InvalidCommitmentMessage
    );
    require!(
        msg[2..18] == global_config.message_domain,
        VaultError::InvalidMessageDomain
    );

    let flags = msg[18];
    require!(
        flags & !(COMMITMENT_FLAG_AUTHORIZED_SETTLER | COMMITMENT_FLAG_FEE) == 0,
        VaultError::InvalidCommitmentMessage
    );

    let mut offset = COMMITMENT_FIXED_HEADER_SIZE;
    let payer_id = read_varint_u32(msg, &mut offset)?;
    let payee_id = read_varint_u32(msg, &mut offset)?;
    require!(
        msg.len() >= offset + 2,
        VaultError::InvalidCommitmentMessage
    );
    let token_id = u16::from_le_bytes(msg[offset..offset + 2].try_into().unwrap());
    offset += 2;

    let lane_generation = read_varint_u32(msg, &mut offset)?;
    require!(lane_generation > 0, VaultError::InvalidLaneGeneration);
    let committed_amount = read_varint_u64(msg, &mut offset)?;

    let authorized_settler = if (flags & COMMITMENT_FLAG_AUTHORIZED_SETTLER) != 0 {
        require!(
            msg.len() >= offset + 32,
            VaultError::InvalidCommitmentMessage
        );
        let settler = Pubkey::new_from_array(msg[offset..offset + 32].try_into().unwrap());
        offset += 32;
        Some(settler)
    } else {
        None
    };

    let (fee_amount, fee_recipient_id) = if (flags & COMMITMENT_FLAG_FEE) != 0 {
        let fee_amount = read_varint_u64(msg, &mut offset)?;
        let fee_recipient_id = read_varint_u32(msg, &mut offset)?;
        (fee_amount, fee_recipient_id)
    } else {
        (0u64, 0u32)
    };

    require!(offset == msg.len(), VaultError::InvalidCommitmentMessage);

    Ok(ParsedCommitmentMessage {
        payer_id,
        payee_id,
        token_id,
        lane_generation,
        committed_amount,
        authorized_settler,
        fee_amount,
        fee_recipient_id,
    })
}

fn validate_fee_recipient(
    fee_recipient_info: &AccountInfo,
    program_id: &Pubkey,
    expected_participant_id: u32,
) -> Result<()> {
    ParticipantAccount::verify_expected_account(
        fee_recipient_info,
        program_id,
        expected_participant_id,
    )
}

pub fn handler(ctx: Context<SettleIndividual>) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;

    let ix_data = ed25519::verify_ed25519_ix(&ctx.accounts.instructions_sysvar, 0)?;
    let offsets = ed25519::parse_ed25519_offsets(&ix_data, 0)?;

    let signer_pubkey = ed25519::extract_pubkey(&ix_data, &offsets)?;
    require!(
        signer_pubkey == ctx.accounts.channel_state.authorized_signer,
        VaultError::InvalidSignature
    );

    let message = ed25519::extract_message(&ix_data, &offsets)?;
    let parsed = parse_commitment_message(&message, &ctx.accounts.global_config)?;

    ctx.accounts
        .token_registry
        .find_token(parsed.token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let channel = &mut ctx.accounts.channel_state;
    require!(
        channel.token_id == parsed.token_id,
        VaultError::InvalidTokenMint
    );
    require!(
        channel.lane_generation == parsed.lane_generation,
        VaultError::InvalidLaneGeneration
    );
    require!(
        channel.payer_id == parsed.payer_id,
        VaultError::AccountIdMismatch
    );
    require!(
        channel.payee_id == parsed.payee_id,
        VaultError::AccountIdMismatch
    );
    require!(
        channel.payer_id == ctx.accounts.payer_account.participant_id,
        VaultError::AccountIdMismatch
    );
    require!(
        channel.payee_id == ctx.accounts.payee_account.participant_id,
        VaultError::AccountIdMismatch
    );

    let submitter_ok = ctx.accounts.submitter.key() == ctx.accounts.payee_account.owner
        || parsed
            .authorized_settler
            .map(|settler| settler == ctx.accounts.submitter.key())
            .unwrap_or(false);
    require!(submitter_ok, VaultError::UnauthorizedSettler);

    let fee_recipient_is_payer =
        parsed.fee_amount > 0 && parsed.fee_recipient_id == channel.payer_id;
    let fee_recipient_is_payee =
        parsed.fee_amount > 0 && parsed.fee_recipient_id == channel.payee_id;
    if parsed.fee_amount > 0 && !fee_recipient_is_payer && !fee_recipient_is_payee {
        require!(
            ctx.remaining_accounts.len() == 1,
            VaultError::FeeRecipientRequired
        );
        validate_fee_recipient(
            &ctx.remaining_accounts[0],
            program_id,
            parsed.fee_recipient_id,
        )?;
    } else {
        require!(
            ctx.remaining_accounts.is_empty(),
            VaultError::FeeRecipientRequired
        );
    }

    require!(
        parsed.committed_amount > channel.settled_cumulative,
        VaultError::CommitmentAmountMustIncrease
    );

    let amount = parsed
        .committed_amount
        .checked_sub(channel.settled_cumulative)
        .ok_or(error!(VaultError::MathOverflow))?;
    let total_debit = amount
        .checked_add(parsed.fee_amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    let payer = &mut ctx.accounts.payer_account;
    let payer_token_balance = payer.get_token_total_balance(parsed.token_id)?;
    let total_available = channel
        .locked_balance
        .checked_add(payer_token_balance)
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        total_available >= total_debit,
        VaultError::InsufficientBalance
    );

    let locked_consumed = channel.locked_balance.min(total_debit);
    let shared_debit = total_debit
        .checked_sub(locked_consumed)
        .ok_or(error!(VaultError::MathOverflow))?;
    let from_locked = locked_consumed > 0;

    channel.settled_cumulative = parsed.committed_amount;
    channel.locked_balance -= locked_consumed;

    let mut balance_deltas: Vec<ParticipantBalanceDelta> = Vec::with_capacity(3);
    add_balance_delta(
        &mut balance_deltas,
        channel.payer_id,
        -(shared_debit as i128),
    )?;
    add_balance_delta(&mut balance_deltas, channel.payee_id, amount as i128)?;
    if parsed.fee_amount > 0 {
        add_balance_delta(
            &mut balance_deltas,
            parsed.fee_recipient_id,
            parsed.fee_amount as i128,
        )?;
    }

    let payer_delta = find_balance_delta(&balance_deltas, channel.payer_id);
    apply_balance_delta(payer, parsed.token_id, payer_delta)?;

    if channel.payee_id != channel.payer_id {
        let payee_delta = find_balance_delta(&balance_deltas, channel.payee_id);
        apply_balance_delta(
            &mut ctx.accounts.payee_account,
            parsed.token_id,
            payee_delta,
        )?;
    }

    if parsed.fee_amount > 0 && !fee_recipient_is_payer && !fee_recipient_is_payee {
        apply_balance_delta_to_account_info(
            &ctx.remaining_accounts[0],
            program_id,
            parsed.fee_recipient_id,
            parsed.token_id,
            find_balance_delta(&balance_deltas, parsed.fee_recipient_id),
        )?;
    }

    emit!(IndividualSettled {
        payer_id: channel.payer_id,
        payee_id: channel.payee_id,
        token_id: parsed.token_id,
        lane_generation: channel.lane_generation,
        amount,
        committed_amount: parsed.committed_amount,
        from_locked,
        fee_amount: parsed.fee_amount,
        fee_recipient_id: if parsed.fee_amount > 0 {
            Some(parsed.fee_recipient_id)
        } else {
            None
        },
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleIndividual<'info> {
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
    pub payer_account: Account<'info, ParticipantAccount>,

    #[account(mut)]
    pub payee_account: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        seeds = [
            ChannelState::SEED_PREFIX,
            payer_account.participant_id.to_le_bytes().as_ref(),
            payee_account.participant_id.to_le_bytes().as_ref(),
            channel_state.token_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub channel_state: Account<'info, ChannelState>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 and CPI verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
