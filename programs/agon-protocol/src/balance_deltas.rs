use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::ParticipantAccount;

#[derive(Clone, Copy)]
pub struct ParticipantBalanceDelta {
    pub participant_id: u32,
    pub amount_delta: i128,
}

pub fn add_balance_delta(
    deltas: &mut Vec<ParticipantBalanceDelta>,
    participant_id: u32,
    amount_delta: i128,
) -> Result<()> {
    if amount_delta == 0 {
        return Ok(());
    }

    if let Some(existing) = deltas
        .iter_mut()
        .find(|delta| delta.participant_id == participant_id)
    {
        existing.amount_delta = existing
            .amount_delta
            .checked_add(amount_delta)
            .ok_or(error!(VaultError::NetPositionOverflow))?;
    } else {
        deltas.push(ParticipantBalanceDelta {
            participant_id,
            amount_delta,
        });
    }

    Ok(())
}

pub fn find_balance_delta(deltas: &[ParticipantBalanceDelta], participant_id: u32) -> i128 {
    deltas
        .iter()
        .find(|delta| delta.participant_id == participant_id)
        .map(|delta| delta.amount_delta)
        .unwrap_or(0)
}

pub fn apply_balance_delta(
    participant: &mut ParticipantAccount,
    token_id: u16,
    amount_delta: i128,
) -> Result<()> {
    if amount_delta > 0 {
        participant.credit_token(token_id, amount_delta as u64)?;
    } else if amount_delta < 0 {
        participant.debit_token(token_id, (-amount_delta) as u64)?;
    }

    Ok(())
}
