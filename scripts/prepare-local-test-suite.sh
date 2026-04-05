#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLANA_BIN="${SOLANA_BIN:-$HOME/.local/share/solana/install/active_release/bin/solana}"
VALIDATOR_BIN="${VALIDATOR_BIN:-$HOME/.local/share/solana/install/active_release/bin/solana-test-validator}"
RPC_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
WALLET="${ANCHOR_WALLET_LINUX:-$REPO_ROOT/keys/devnet-deployer.json}"
PROGRAM_SO="${PROGRAM_SO:-$REPO_ROOT/target/deploy/agon_protocol.so}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-$REPO_ROOT/target/deploy/agon_protocol-keypair.json}"
VALIDATOR_LOG="${VALIDATOR_LOG:-/tmp/agon-local-validator.log}"

if [[ ! -x "$SOLANA_BIN" ]]; then
  echo "solana binary not found at $SOLANA_BIN" >&2
  exit 1
fi

if [[ ! -x "$VALIDATOR_BIN" ]]; then
  echo "solana-test-validator binary not found at $VALIDATOR_BIN" >&2
  exit 1
fi

if [[ ! -f "$WALLET" ]]; then
  echo "wallet not found at $WALLET" >&2
  exit 1
fi

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "program binary not found at $PROGRAM_SO" >&2
  exit 1
fi

if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "program keypair not found at $PROGRAM_KEYPAIR" >&2
  exit 1
fi

pkill -f solana-test-validator >/dev/null 2>&1 || true
pkill -f solana-faucet >/dev/null 2>&1 || true
sleep 1
nohup "$VALIDATOR_BIN" --reset > "$VALIDATOR_LOG" 2>&1 &

READY=0
for _ in $(seq 1 30); do
  if "$SOLANA_BIN" -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "local validator did not become ready; see $VALIDATOR_LOG" >&2
  exit 1
fi

"$SOLANA_BIN" -u "$RPC_URL" airdrop 20 "$WALLET" >/dev/null
"$SOLANA_BIN" config set --url "$RPC_URL" --keypair "$WALLET" >/dev/null
"$SOLANA_BIN" program deploy "$PROGRAM_SO" --program-id "$PROGRAM_KEYPAIR" >/dev/null

echo "local validator ready at $RPC_URL"
echo "wallet: $WALLET"
echo "validator log: $VALIDATOR_LOG"
