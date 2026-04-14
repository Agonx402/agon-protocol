#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import {
  createHash,
  createPrivateKey,
  sign as cryptoSign,
} from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AgonProtocol } from "../target/types/agon_protocol";
import {
  type BenchmarkShape,
  type DemoBenchmarkScenario,
  computeSavingsMetrics,
  explorerUrl as buildExplorerUrl,
} from "./lib/benchmark-artifacts";
import {
  type ClearingRoundCapacitySummary,
  LEGACY_PACKET_DATA_SIZE,
  measureClearingRoundCapacity,
  summarizeClearingRoundCapacity,
} from "./lib/clearing-round-capacity";

const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const PARTICIPANT_SEED = "participant";
const CHANNEL_SEED = "channel-v2";
const VAULT_TOKEN_ACCOUNT_SEED = "vault-token-account";
const USED_SIGNATURE_SEED = "used-sig";
const MULTILATERAL_NAMESPACE = "mnet";
const DEFAULT_USDC_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const DEFAULT_TOKEN_ID = 1;
const DEFAULT_TOKEN_SYMBOL = "USDC";
const DEFAULT_WALLET_COUNT = 6;
const MAX_WALLET_COUNT = 10;
const DEFAULT_SOL_PER_WALLET = 0.1;
const DEFAULT_USDC_PER_WALLET = 1000;
const DEFAULT_DEPOSIT_PLAN: Record<string, number> = {
  Alice: 350,
  Bob: 120,
  Carol: 120,
  Dave: 80,
  Erin: 80,
  Frank: 80,
};
const DEFAULT_SINGLE_COMMITMENT_COUNT = 1;
const DEFAULT_SINGLE_COMMITMENT_AMOUNT = 25;
const DEFAULT_SINGLE_COMMITMENT_LOG_EVERY = 1;
const DEFAULT_BATCH_COMMITMENT_BATCH_COUNT = 1;
const DEFAULT_BATCH_COMMITMENT_BATCH_SIZE = 5;
const DEFAULT_BATCH_COMMITMENT_AMOUNT = 5;
const DEFAULT_BATCH_COMMITMENT_LOG_EVERY = 1;
const MAX_BUNDLE_CHANNELS_PER_TX = 2;
const DEFAULT_UNILATERAL_PAYEE_A_COMMITMENT_COUNT = 400;
const DEFAULT_UNILATERAL_PAYEE_B_COMMITMENT_COUNT = 300;
const DEFAULT_UNILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const DEFAULT_UNILATERAL_LOCK_AMOUNT = 10;
const DEFAULT_BILATERAL_FORWARD_COMMITMENT_COUNT = 350;
const DEFAULT_BILATERAL_REVERSE_COMMITMENT_COUNT = 200;
const DEFAULT_BILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const DEFAULT_MULTILATERAL_EDGE_COMMITMENT_COUNT = 220;
const DEFAULT_MULTILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const X402_SOLANA_COST_PER_TX_USD = 0.0008;
const SIGNED_COMMITMENT_PREVIEW_COUNT = 4;
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

type SupportedNetwork = "devnet" | "mainnet" | "testnet" | "localnet";

type CliOptions = {
  configFilePath: string | null;
  walletCount: number;
  activeWalletNames: string[] | null;
  tokenId: number;
  tokenMint: PublicKey;
  tokenSymbol: string;
  solPerWallet: number;
  tokensPerWallet: number;
  reuseManifestPath: string | null;
  skipFunding: boolean;
  skipParticipantInit: boolean;
  skipDeposits: boolean;
  depositPlan: Record<string, number>;
  singleCommitmentCount: number;
  singleCommitmentAmount: number;
  singleCommitmentLogEvery: number;
  batchCommitmentBatchCount: number;
  batchCommitmentBatchSize: number;
  batchCommitmentAmount: number;
  batchCommitmentLogEvery: number;
  unilateralPayeeACommitmentCount: number;
  unilateralPayeeBCommitmentCount: number;
  unilateralAmountPerCommitment: number;
  unilateralLockAmount: number;
  bilateralForwardCommitmentCount: number;
  bilateralReverseCommitmentCount: number;
  bilateralAmountPerCommitment: number;
  multilateralEdgeCommitmentCount: number;
  multilateralAmountPerCommitment: number;
};

type DemoWallet = {
  name: string;
  keypair: Keypair;
  secretPath: string;
  participantPda: PublicKey;
  participantId: number;
  tokenAccount: PublicKey;
};

type TokenBalanceView = {
  available: number;
  withdrawing: number;
};

type ChannelEntrySpec = {
  payeeRef: number;
  targetCumulative: number;
};

type ParticipantBlockSpec = {
  participantId: number;
  entries: {
    payeeRef: number;
    targetCumulative: number;
  }[];
};

type SignedCommitmentPreviewInput = {
  payer: DemoWallet;
  payee: DemoWallet;
  committedAmount: number;
  tokenId: number;
};

type DirectCommitmentPayloadPreview = {
  signedBy: string;
  payload: {
    kind: number;
    version: number;
    messageDomain: string;
    flags: number;
    payer: string;
    payee: string;
    payerId: number;
    payeeId: number;
    tokenId: number;
    committedAmount: string;
  };
  signature: string;
};

type SignedCommitmentPreview = {
  example: DirectCommitmentPayloadPreview;
  signatures: string[];
};

type CommitmentBundlePayloadPreview = {
  kind: number;
  version: number;
  messageDomain: string;
  payee: string;
  payeeId: number;
  tokenId: number;
  token: string;
  entryCount: number;
  entries: {
    signedBy: string;
    payerId: number;
    committedAmount: string;
    signature: string;
  }[];
};

type ClearingRoundPreviewBlockInput = {
  participant: DemoWallet;
  entries: {
    payeeRef: number;
    payee: DemoWallet;
    targetCumulative: number;
  }[];
};

type ClearingRoundPayloadPreview = {
  kind: number;
  version: number;
  messageDomain: string;
  tokenId: number;
  token: string;
  participantCount: number;
  channelCount: number;
  cosignedBy: string[];
  participantBlocks: {
    participant: string;
    participantId: number;
    entryCount: number;
    entries: {
      channel: string;
      payeeRef: number;
      targetCumulative: string;
    }[];
  }[];
  signatures: string[];
};

type ScenarioSignatureMap = {
  singleCommitment: string;
  batchCommitment: string;
  unilateralClearing: string;
  bilateralClearing: string;
  multilateralClearing: string;
};

type ScenarioResult = {
  primarySignature: string;
  benchmark: DemoBenchmarkScenario;
};

type MultilateralScenarioResult = ScenarioResult & {
  settledChannelCount: number;
};

type MultilateralSearchTarget = {
  balanced: BenchmarkShape;
  overall: BenchmarkShape;
};

type DemoManifestWallet = {
  name: string;
  publicKey: string;
  participantId?: number;
  participantPda?: string;
  tokenAccount?: string;
  secretPath: string;
};

type DemoRunManifest = {
  runId: string;
  network: string;
  rpcEndpoint: string;
  programId: string;
  deployer: string;
  token: {
    id: number;
    symbol: string;
    mint: string;
    decimals: number;
    vaultTokenAccount: string;
  };
  feeRecipient: string;
  wallets: DemoManifestWallet[];
  messageDomain?: string;
};

function loadConfigFile(
  repoRoot: string,
  rawPath: string | undefined
): Record<string, string> {
  const configPath = resolveInputPath(
    repoRoot,
    rawPath ?? path.join("config", "agon-protocol-demo.env")
  );
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseBooleanOption(
  rawValue: string | undefined,
  fallback = false
): boolean {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function parseIntegerOption(
  rawValue: string | undefined,
  fallback: number,
  label: string,
  minimum = 0
): number {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseNameListOption(rawValue: string | undefined): string[] | null {
  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }
  const names = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : null;
}

function parseFloatOption(
  rawValue: string | undefined,
  fallback: number,
  label: string,
  minimum = 0
): number {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${label} must be a number >= ${minimum}`);
  }
  return parsed;
}

function parseDepositPlan(
  rawValue: string | undefined
): Record<string, number> {
  if (!rawValue || rawValue.trim() === "") {
    return { ...DEFAULT_DEPOSIT_PLAN };
  }
  const parsed = JSON.parse(rawValue);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGON_DEMO_DEPOSIT_PLAN_JSON must be a JSON object");
  }
  const depositPlan: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Deposit amount for ${name} must be a number >= 0`);
    }
    depositPlan[name] = value;
  }
  return depositPlan;
}

function maybeTranslateWslPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("//wsl.localhost/Ubuntu/")) {
    return `/${normalized.slice("//wsl.localhost/Ubuntu/".length)}`;
  }
  if (normalized.startsWith("//wsl$/Ubuntu/")) {
    return `/${normalized.slice("//wsl$/Ubuntu/".length)}`;
  }
  return normalized;
}

function resolveInputPath(repoRoot: string, rawPath: string): string {
  const translated = maybeTranslateWslPath(rawPath);
  if (fs.existsSync(translated)) {
    return translated;
  }
  const candidate = path.isAbsolute(translated)
    ? translated
    : path.join(repoRoot, translated);
  return candidate;
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  const repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const trimmed = value.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      args.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(trimmed, next);
      i += 1;
    } else {
      args.set(trimmed, "true");
    }
  }
  if (args.has("help")) {
    console.log(
      "Usage: npx ts-node scripts/agon-protocol-demo.ts [--config-file config/agon-protocol-demo.env] [--wallet-count 6] [--token-id 1] [--mint <pubkey>] [--symbol USDC] [--reuse-manifest config/agon-protocol-demo-last-run.json]"
    );
    process.exit(0);
  }
  const configFilePath =
    args.get("config-file") ??
    process.env.AGON_DEMO_CONFIG_FILE ??
    path.join("config", "agon-protocol-demo.env");
  const configValues = loadConfigFile(repoRoot, configFilePath);
  const getValue = (cliName: string, envName: string): string | undefined =>
    args.get(cliName) ?? process.env[envName] ?? configValues[envName];
  const walletCount = parseIntegerOption(
    getValue("wallet-count", "AGON_DEMO_WALLET_COUNT"),
    DEFAULT_WALLET_COUNT,
    "wallet-count",
    DEFAULT_WALLET_COUNT
  );
  if (!Number.isInteger(walletCount) || walletCount < DEFAULT_WALLET_COUNT) {
    throw new Error(
      `wallet-count must be an integer >= ${DEFAULT_WALLET_COUNT}`
    );
  }
  if (walletCount > MAX_WALLET_COUNT) {
    throw new Error(`wallet-count must be <= ${MAX_WALLET_COUNT}`);
  }
  const tokenIdRaw =
    getValue("token-id", "AGON_DEMO_TOKEN_ID") ?? `${DEFAULT_TOKEN_ID}`;
  const tokenId = Number.parseInt(tokenIdRaw, 10);
  const tokenMint = new PublicKey(
    getValue("mint", "AGON_DEMO_MINT") ?? DEFAULT_USDC_MINT
  );
  const tokenSymbol =
    getValue("symbol", "AGON_DEMO_SYMBOL") ?? DEFAULT_TOKEN_SYMBOL;
  const solPerWallet = parseFloatOption(
    getValue("sol-per-wallet", "AGON_DEMO_SOL_PER_WALLET"),
    DEFAULT_SOL_PER_WALLET,
    "sol-per-wallet"
  );
  const tokensPerWallet = parseFloatOption(
    getValue("tokens-per-wallet", "AGON_DEMO_TOKENS_PER_WALLET"),
    DEFAULT_USDC_PER_WALLET,
    "tokens-per-wallet"
  );
  const reuseManifestPath =
    getValue("reuse-manifest", "AGON_DEMO_REUSE_MANIFEST") ?? null;
  const skipFunding = parseBooleanOption(
    getValue("skip-funding", "AGON_DEMO_SKIP_FUNDING"),
    false
  );
  const skipParticipantInit = parseBooleanOption(
    getValue("skip-participant-init", "AGON_DEMO_SKIP_PARTICIPANT_INIT"),
    false
  );
  const skipDeposits = parseBooleanOption(
    getValue("skip-deposits", "AGON_DEMO_SKIP_DEPOSITS"),
    false
  );
  return {
    configFilePath,
    walletCount,
    activeWalletNames: parseNameListOption(
      getValue("active-wallets", "AGON_DEMO_ACTIVE_WALLETS")
    ),
    tokenId,
    tokenMint,
    tokenSymbol,
    solPerWallet,
    tokensPerWallet,
    reuseManifestPath,
    skipFunding,
    skipParticipantInit,
    skipDeposits,
    depositPlan: parseDepositPlan(
      getValue("deposit-plan-json", "AGON_DEMO_DEPOSIT_PLAN_JSON")
    ),
    singleCommitmentCount: parseIntegerOption(
      getValue("single-commitment-count", "AGON_DEMO_SINGLE_COMMITMENT_COUNT"),
      DEFAULT_SINGLE_COMMITMENT_COUNT,
      "AGON_DEMO_SINGLE_COMMITMENT_COUNT",
      1
    ),
    singleCommitmentAmount: parseFloatOption(
      getValue(
        "single-commitment-amount",
        "AGON_DEMO_SINGLE_COMMITMENT_AMOUNT"
      ),
      DEFAULT_SINGLE_COMMITMENT_AMOUNT,
      "AGON_DEMO_SINGLE_COMMITMENT_AMOUNT",
      0
    ),
    singleCommitmentLogEvery: parseIntegerOption(
      getValue(
        "single-commitment-log-every",
        "AGON_DEMO_SINGLE_COMMITMENT_LOG_EVERY"
      ),
      DEFAULT_SINGLE_COMMITMENT_LOG_EVERY,
      "AGON_DEMO_SINGLE_COMMITMENT_LOG_EVERY",
      1
    ),
    batchCommitmentBatchCount: parseIntegerOption(
      getValue(
        "batch-commitment-batch-count",
        "AGON_DEMO_BATCH_COMMITMENT_BATCH_COUNT"
      ),
      DEFAULT_BATCH_COMMITMENT_BATCH_COUNT,
      "AGON_DEMO_BATCH_COMMITMENT_BATCH_COUNT",
      1
    ),
    batchCommitmentBatchSize: parseIntegerOption(
      getValue(
        "batch-commitment-batch-size",
        "AGON_DEMO_BATCH_COMMITMENT_BATCH_SIZE"
      ),
      DEFAULT_BATCH_COMMITMENT_BATCH_SIZE,
      "AGON_DEMO_BATCH_COMMITMENT_BATCH_SIZE",
      1
    ),
    batchCommitmentAmount: parseFloatOption(
      getValue("batch-commitment-amount", "AGON_DEMO_BATCH_COMMITMENT_AMOUNT"),
      DEFAULT_BATCH_COMMITMENT_AMOUNT,
      "AGON_DEMO_BATCH_COMMITMENT_AMOUNT",
      0
    ),
    batchCommitmentLogEvery: parseIntegerOption(
      getValue(
        "batch-commitment-log-every",
        "AGON_DEMO_BATCH_COMMITMENT_LOG_EVERY"
      ),
      DEFAULT_BATCH_COMMITMENT_LOG_EVERY,
      "AGON_DEMO_BATCH_COMMITMENT_LOG_EVERY",
      1
    ),
    unilateralPayeeACommitmentCount: parseIntegerOption(
      getValue(
        "unilateral-payee-a-commitments",
        "AGON_DEMO_UNILATERAL_PAYEE_A_COMMITMENTS"
      ),
      DEFAULT_UNILATERAL_PAYEE_A_COMMITMENT_COUNT,
      "AGON_DEMO_UNILATERAL_PAYEE_A_COMMITMENTS",
      1
    ),
    unilateralPayeeBCommitmentCount: parseIntegerOption(
      getValue(
        "unilateral-payee-b-commitments",
        "AGON_DEMO_UNILATERAL_PAYEE_B_COMMITMENTS"
      ),
      DEFAULT_UNILATERAL_PAYEE_B_COMMITMENT_COUNT,
      "AGON_DEMO_UNILATERAL_PAYEE_B_COMMITMENTS",
      1
    ),
    unilateralAmountPerCommitment: parseFloatOption(
      getValue("unilateral-amount", "AGON_DEMO_UNILATERAL_AMOUNT"),
      DEFAULT_UNILATERAL_AMOUNT_PER_COMMITMENT,
      "AGON_DEMO_UNILATERAL_AMOUNT",
      0
    ),
    unilateralLockAmount: parseFloatOption(
      getValue("unilateral-lock-amount", "AGON_DEMO_UNILATERAL_LOCK_AMOUNT"),
      DEFAULT_UNILATERAL_LOCK_AMOUNT,
      "AGON_DEMO_UNILATERAL_LOCK_AMOUNT",
      0
    ),
    bilateralForwardCommitmentCount: parseIntegerOption(
      getValue(
        "bilateral-forward-commitments",
        "AGON_DEMO_BILATERAL_FORWARD_COMMITMENTS"
      ),
      DEFAULT_BILATERAL_FORWARD_COMMITMENT_COUNT,
      "AGON_DEMO_BILATERAL_FORWARD_COMMITMENTS",
      1
    ),
    bilateralReverseCommitmentCount: parseIntegerOption(
      getValue(
        "bilateral-reverse-commitments",
        "AGON_DEMO_BILATERAL_REVERSE_COMMITMENTS"
      ),
      DEFAULT_BILATERAL_REVERSE_COMMITMENT_COUNT,
      "AGON_DEMO_BILATERAL_REVERSE_COMMITMENTS",
      1
    ),
    bilateralAmountPerCommitment: parseFloatOption(
      getValue("bilateral-amount", "AGON_DEMO_BILATERAL_AMOUNT"),
      DEFAULT_BILATERAL_AMOUNT_PER_COMMITMENT,
      "AGON_DEMO_BILATERAL_AMOUNT",
      0
    ),
    multilateralEdgeCommitmentCount: parseIntegerOption(
      getValue(
        "multilateral-edge-commitments",
        "AGON_DEMO_MULTILATERAL_EDGE_COMMITMENTS"
      ),
      DEFAULT_MULTILATERAL_EDGE_COMMITMENT_COUNT,
      "AGON_DEMO_MULTILATERAL_EDGE_COMMITMENTS",
      1
    ),
    multilateralAmountPerCommitment: parseFloatOption(
      getValue("multilateral-amount", "AGON_DEMO_MULTILATERAL_AMOUNT"),
      DEFAULT_MULTILATERAL_AMOUNT_PER_COMMITMENT,
      "AGON_DEMO_MULTILATERAL_AMOUNT",
      0
    ),
  };
}

function inferNetwork(rpcEndpoint: string): SupportedNetwork {
  if (rpcEndpoint.includes("mainnet")) return "mainnet";
  if (rpcEndpoint.includes("devnet")) return "devnet";
  if (rpcEndpoint.includes("testnet")) return "testnet";
  if (rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost")) {
    return "localnet";
  }
  return "localnet";
}

function findTokenRegistryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    programId
  )[0];
}

function findGlobalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_CONFIG_SEED)],
    programId
  )[0];
}

function findParticipantPda(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PARTICIPANT_SEED), owner.toBytes()],
    programId
  )[0];
}

function findChannelPda(
  programId: PublicKey,
  payerId: number,
  payeeId: number,
  tokenId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(CHANNEL_SEED),
      new anchor.BN(payerId).toArrayLike(Buffer, "le", 4),
      new anchor.BN(payeeId).toArrayLike(Buffer, "le", 4),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    programId
  )[0];
}

function findVaultTokenAccountPda(
  programId: PublicKey,
  tokenId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_TOKEN_ACCOUNT_SEED),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    programId
  )[0];
}

function sha256Bytes(data: Buffer | Uint8Array): number[] {
  return [...createHash("sha256").update(data).digest()];
}

function encodeCompactU64(value: bigint): number[] {
  if (value < 0n) {
    throw new Error("Compact values must be unsigned");
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

function signEd25519Message(message: Buffer, signer: Keypair): Buffer {
  const seed = signer.secretKey.slice(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return Buffer.from(cryptoSign(null, message, privateKey));
}

function buildOrderedParticipantPairs<T>(participants: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let offset = 1; offset < participants.length; offset += 1) {
    for (let payerIndex = 0; payerIndex < participants.length; payerIndex += 1) {
      pairs.push([
        participants[payerIndex],
        participants[(payerIndex + offset) % participants.length],
      ]);
    }
  }
  return pairs;
}

function createBatchEd25519Instruction(
  signer: Keypair,
  messages: Buffer[]
): TransactionInstruction {
  const headerSize = 2 + 14 * messages.length;
  const blockSize = 32 + 64;
  const totalMessagesSize = messages.reduce((sum, msg) => sum + msg.length, 0);
  const blockStart = headerSize;
  const messageStart = blockStart + messages.length * blockSize;
  const data = Buffer.alloc(messageStart + totalMessagesSize);
  data[0] = messages.length;
  data[1] = 0;
  let runningMessageOffset = messageStart;
  for (let i = 0; i < messages.length; i += 1) {
    const entryOffset = 2 + i * 14;
    const publicKeyOffset = blockStart + i * blockSize;
    const signatureOffset = publicKeyOffset + 32;
    const signature = signEd25519Message(messages[i], signer);
    data.writeUInt16LE(signatureOffset, entryOffset);
    data.writeUInt16LE(0xffff, entryOffset + 2);
    data.writeUInt16LE(publicKeyOffset, entryOffset + 4);
    data.writeUInt16LE(0xffff, entryOffset + 6);
    data.writeUInt16LE(runningMessageOffset, entryOffset + 8);
    data.writeUInt16LE(messages[i].length, entryOffset + 10);
    data.writeUInt16LE(0xffff, entryOffset + 12);
    Buffer.from(signer.publicKey.toBytes()).copy(data, publicKeyOffset);
    signature.copy(data, signatureOffset);
    messages[i].copy(data, runningMessageOffset);
    runningMessageOffset += messages[i].length;
  }
  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createMultiSigEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const headerSize = 2 + 14 * signers.length;
  const blockSize = 32 + 64;
  const messageOffset = headerSize + signers.length * blockSize;
  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = signers.length;
  data[1] = 0;
  for (let i = 0; i < signers.length; i += 1) {
    const entryOffset = 2 + i * 14;
    const publicKeyOffset = headerSize + i * blockSize;
    const signatureOffset = publicKeyOffset + 32;
    const signature = signEd25519Message(message, signers[i]);
    data.writeUInt16LE(signatureOffset, entryOffset);
    data.writeUInt16LE(0xffff, entryOffset + 2);
    data.writeUInt16LE(publicKeyOffset, entryOffset + 4);
    data.writeUInt16LE(0xffff, entryOffset + 6);
    data.writeUInt16LE(messageOffset, entryOffset + 8);
    data.writeUInt16LE(message.length, entryOffset + 10);
    data.writeUInt16LE(0xffff, entryOffset + 12);
    Buffer.from(signers[i].publicKey.toBytes()).copy(data, publicKeyOffset);
    signature.copy(data, signatureOffset);
  }
  message.copy(data, messageOffset);
  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createMultiMessageEd25519Instruction(
  entries: { signer: Keypair; message: Buffer }[]
): TransactionInstruction {
  const headerSize = 2 + 14 * entries.length;
  let cursor = headerSize;
  const buffers: Buffer[] = [];
  const rows: Array<{
    signatureOffset: number;
    publicKeyOffset: number;
    messageOffset: number;
    messageLength: number;
  }> = [];

  for (const entry of entries) {
    const publicKeyOffset = cursor;
    const signatureOffset = publicKeyOffset + 32;
    const messageOffset = signatureOffset + 64;
    const signature = signEd25519Message(entry.message, entry.signer);

    buffers.push(
      Buffer.from(entry.signer.publicKey.toBytes()),
      Buffer.from(signature),
      entry.message
    );
    rows.push({
      signatureOffset,
      publicKeyOffset,
      messageOffset,
      messageLength: entry.message.length,
    });
    cursor = messageOffset + entry.message.length;
  }

  const data = Buffer.alloc(cursor);
  data[0] = entries.length;
  data[1] = 0;

  rows.forEach((row, index) => {
    const headerOffset = 2 + index * 14;
    data.writeUInt16LE(row.signatureOffset, headerOffset);
    data.writeUInt16LE(0xffff, headerOffset + 2);
    data.writeUInt16LE(row.publicKeyOffset, headerOffset + 4);
    data.writeUInt16LE(0xffff, headerOffset + 6);
    data.writeUInt16LE(row.messageOffset, headerOffset + 8);
    data.writeUInt16LE(row.messageLength, headerOffset + 10);
    data.writeUInt16LE(0xffff, headerOffset + 12);
  });

  let writeOffset = headerSize;
  for (const buffer of buffers) {
    buffer.copy(data, writeOffset);
    writeOffset += buffer.length;
  }

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createCommitmentMessage(params: {
  payerId: number;
  payeeId: number;
  committedAmount?: number;
  amount?: number;
  tokenId: number;
  messageDomain: Buffer | Uint8Array;
}): Buffer {
  const committedAmount = params.committedAmount ?? params.amount;
  if (committedAmount === undefined) {
    throw new Error(
      "createCommitmentMessage requires committedAmount (or amount alias)"
    );
  }
  return Buffer.concat([
    Buffer.from([0x01, 0x05]),
    Buffer.from(params.messageDomain),
    Buffer.from([0x00]),
    Buffer.from(encodeCompactU64(BigInt(params.payerId))),
    Buffer.from(encodeCompactU64(BigInt(params.payeeId))),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from(encodeCompactU64(BigInt(committedAmount))),
  ]);
}

function createClearingRoundMessage(params: {
  tokenId: number;
  messageDomain: Buffer | Uint8Array;
  blocks: ParticipantBlockSpec[];
}): Buffer {
  const dynamicParts: number[] = [];
  for (const block of params.blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);
    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(...encodeCompactU64(BigInt(entry.targetCumulative)));
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, 0x04]),
    Buffer.from(params.messageDomain),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from([params.blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

function toRawAmount(amount: number, decimals: number): number {
  const raw = Math.round(amount * 10 ** decimals);
  if (!Number.isSafeInteger(raw)) {
    throw new Error(`Amount ${amount} is not safely representable`);
  }
  return raw;
}

function formatAmount(rawAmount: number | bigint, decimals: number): string {
  const raw = rawAmount.toString();
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fractional = padded.slice(padded.length - decimals).replace(/0+$/g, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole;
}

function formatUsd(amount: number): string {
  if (amount >= 1000) {
    return `$${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (amount >= 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount >= 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(6)}`;
}

function trimHex(value: string, visible = 10): string {
  if (value.length <= visible * 2 + 3) {
    return value;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function formatCompressionRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "inf";
  }
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function buildSignedCommitmentPreview(params: {
  messageDomain: Buffer;
  decimals: number;
  tokenSymbol: string;
  inputs: SignedCommitmentPreviewInput[];
}): SignedCommitmentPreview {
  if (params.inputs.length === 0) {
    throw new Error("At least one commitment preview input is required");
  }

  const entries = params.inputs.map((input) => {
    const message = createCommitmentMessage({
      payerId: input.payer.participantId,
      payeeId: input.payee.participantId,
      committedAmount: input.committedAmount,
      tokenId: input.tokenId,
      messageDomain: params.messageDomain,
    });
    return {
      signedBy: input.payer.name,
      payload: {
        kind: 0x01,
        version: 0x04,
        messageDomain: trimHex(params.messageDomain.toString("hex")),
        flags: 0,
        payer: input.payer.name,
        payee: input.payee.name,
        payerId: input.payer.participantId,
        payeeId: input.payee.participantId,
        tokenId: input.tokenId,
        committedAmount: `${formatAmount(
          input.committedAmount,
          params.decimals
        )} ${params.tokenSymbol}`,
      },
      signature: trimHex(
        `0x${signEd25519Message(message, input.payer.keypair).toString("hex")}`
      ),
    };
  });

  return {
    example: entries[0],
    signatures: entries.map((entry) => entry.signature),
  };
}

function buildCommitmentBundlePayloadPreview(params: {
  messageDomain: Buffer;
  decimals: number;
  tokenId: number;
  tokenSymbol: string;
  payee: DemoWallet;
  inputs: SignedCommitmentPreviewInput[];
}): CommitmentBundlePayloadPreview {
  return {
    kind: 0x01,
    version: 0x04,
    messageDomain: trimHex(params.messageDomain.toString("hex")),
    payee: params.payee.name,
    payeeId: params.payee.participantId,
    tokenId: params.tokenId,
    token: params.tokenSymbol,
    entryCount: params.inputs.length,
    entries: params.inputs.map((input) => {
      const message = createCommitmentMessage({
        payerId: input.payer.participantId,
        payeeId: input.payee.participantId,
        committedAmount: input.committedAmount,
        tokenId: input.tokenId,
        messageDomain: params.messageDomain,
      });
      return {
        signedBy: input.payer.name,
        payerId: input.payer.participantId,
        committedAmount: `${formatAmount(
          input.committedAmount,
          params.decimals
        )} ${params.tokenSymbol}`,
        signature: trimHex(
          `0x${signEd25519Message(message, input.payer.keypair).toString(
            "hex"
          )}`
        ),
      };
    }),
  };
}

function buildClearingRoundPayloadPreview(params: {
  messageDomain: Buffer;
  tokenId: number;
  tokenSymbol: string;
  decimals: number;
  blocks: ClearingRoundPreviewBlockInput[];
}): ClearingRoundPayloadPreview {
  const message = createClearingRoundMessage({
    tokenId: params.tokenId,
    messageDomain: params.messageDomain,
    blocks: params.blocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });

  return {
    kind: 0x02,
    version: 0x04,
    messageDomain: trimHex(params.messageDomain.toString("hex")),
    tokenId: params.tokenId,
    token: params.tokenSymbol,
    participantCount: params.blocks.length,
    channelCount: params.blocks.reduce(
      (sum, block) => sum + block.entries.length,
      0
    ),
    cosignedBy: params.blocks.map((block) => block.participant.name),
    participantBlocks: params.blocks.map((block) => ({
      participant: block.participant.name,
      participantId: block.participant.participantId,
      entryCount: block.entries.length,
      entries: block.entries.map((entry) => ({
        channel: `${block.participant.name}->${entry.payee.name}`,
        payeeRef: entry.payeeRef,
        targetCumulative: `${formatAmount(
          entry.targetCumulative,
          params.decimals
        )} ${params.tokenSymbol}`,
      })),
    })),
    signatures: params.blocks.map((block) =>
      trimHex(
        `0x${signEd25519Message(message, block.participant.keypair).toString(
          "hex"
        )}`
      )
    ),
  };
}

function logJsonBlock(label: string, value: unknown): void {
  logStep(label);
  const json = JSON.stringify(value, null, 2);
  for (const line of json.split("\n")) {
    logStep(`    ${line}`);
  }
}

function logSignedCommitmentPreview(preview: SignedCommitmentPreview): void {
  logJsonBlock("  Example signed commitment payload:", preview.example);
  logStep(
    `  Example commitment signatures: [${preview.signatures.join(", ")}]`
  );
}

function logCommitmentBundlePayloadPreview(
  preview: CommitmentBundlePayloadPreview
): void {
  logJsonBlock("  What buyers sign before bundle settlement:", preview);
}

function logClearingRoundPayloadPreview(
  preview: ClearingRoundPayloadPreview
): void {
  logJsonBlock("  What agents co-sign in the clearing round:", preview);
}

function logCapacityMeasurement(
  label: string,
  measurement: {
    participantCount: number;
    channelCount: number;
    messageBytes: number;
    authEnvelopeBytes: number;
    serializedTxBytes: number;
    remainingBytes: number;
    fits?: boolean;
  }
): void {
  logStep(
    `${label}: ${measurement.participantCount} participants, ${measurement.channelCount} channels, ${measurement.serializedTxBytes}/${LEGACY_PACKET_DATA_SIZE} bytes ` +
      `(${
        measurement.fits === false
          ? `${Math.abs(measurement.remainingBytes)} bytes over limit`
          : `${measurement.remainingBytes} bytes headroom`
      }, round message ${measurement.messageBytes} bytes, auth envelope ${
        measurement.authEnvelopeBytes
      } bytes)`
  );
}

function determineMultilateralSearchTargets(
  summary: ClearingRoundCapacitySummary,
  availableParticipants: number
): MultilateralSearchTarget {
  const balancedParticipantCount = Math.max(
    3,
    Math.min(summary.currentV0AltCycle.participantCount, availableParticipants)
  );
  const balancedChannelCount = Math.min(
    summary.currentV0AltCycle.channelCount,
    balancedParticipantCount * (balancedParticipantCount - 1)
  );
  const overallParticipantCount = Math.max(
    3,
    Math.min(summary.currentV0AltOverall.participantCount, availableParticipants)
  );
  const overallChannelCount = Math.min(
    summary.currentV0AltOverall.channelCount,
    overallParticipantCount * (overallParticipantCount - 1)
  );

  return {
    balanced: {
      participantCount: balancedParticipantCount,
      channelCount: balancedChannelCount,
    },
    overall: {
      participantCount: overallParticipantCount,
      channelCount: overallChannelCount,
    },
  };
}

function logClearingRoundCapacityAnalysis(
  programId: PublicKey,
  summary: ClearingRoundCapacitySummary,
  requestedShape: BenchmarkShape,
  achievedShape: BenchmarkShape
): void {
  const requestedExecutableV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "current-ed25519-v0-alt",
    participantCount: requestedShape.participantCount,
    channelCount: requestedShape.channelCount,
  });
  const liveExecutableV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "current-ed25519-v0-alt",
    participantCount: achievedShape.participantCount,
    channelCount: achievedShape.channelCount,
  });

  logSection("Clearing Round Capacity");
  logStep(
    "Current multilateral rounds are limited first by transaction bytes and then by program-side runtime overhead. The live submission path today is self-funded v0 + ALT with one shared clearing-round message plus one pubkey/signature block per participant."
  );
  logStep(
    "The numbers below focus only on the live v0 + ALT path today and the same path after BLS aggregate signatures compress signer overhead."
  );
  logCapacityMeasurement(
    "Largest balanced round demonstrated on the current devnet deployment with v0 + ALT",
    liveExecutableV0Alt
  );
  logCapacityMeasurement(
    "Largest overall round that fits in bytes with v0 + ALT today",
    summary.currentV0AltOverall
  );
  logCapacityMeasurement(
    "Hypothetical BLS cycle with v0 + ALT",
    summary.blsV0AltCycle
  );
  logCapacityMeasurement(
    "Hypothetical BLS overall round with v0 + ALT",
    summary.blsV0AltOverall
  );
  if (
    achievedShape.participantCount !== requestedShape.participantCount ||
    achievedShape.channelCount !== requestedShape.channelCount
  ) {
    logStep(
      `The live demo fell back from the requested ${requestedShape.participantCount}-participant / ${requestedShape.channelCount}-channel target to ${achievedShape.participantCount} participants / ${achievedShape.channelCount} channels because current runtime overhead still dominates before the byte ceiling.`
    );
    logCapacityMeasurement(
      "Largest balanced round targeted by the current local/runtime profile",
      requestedExecutableV0Alt
    );
  } else {
    logStep(
      `The requested ${requestedShape.participantCount}-participant / ${requestedShape.channelCount}-channel target executed successfully on the current devnet deployment.`
    );
  }
  logStep(
    "BLS helps with signer/auth overhead, but every included channel still has to be advanced, so the next bottleneck after BLS is program-side state handling rather than transaction bytes."
  );
}

function createBenchmarkScenario(params: {
  id: DemoBenchmarkScenario["id"];
  title: string;
  settlementMode: DemoBenchmarkScenario["settlementMode"];
  participantCount: number;
  channelCount: number;
  underlyingPaymentCount: number;
  grossValueRaw: number;
  decimals: number;
  tokenSymbol: string;
  signatures: string[];
  serializedTransactionBytes: number[];
  signedMessageBytes: number;
  signatureCount: number;
  participantBalanceWrites: number;
  channelStateWrites: number;
  notes?: string[];
  requestedShape?: BenchmarkShape;
  achievedShape?: BenchmarkShape;
}): DemoBenchmarkScenario {
  const savings = computeSavingsMetrics({
    underlyingPaymentCount: params.underlyingPaymentCount,
    settlementTransactionCount: params.signatures.length,
  });

  return {
    id: params.id,
    title: params.title,
    settlementMode: params.settlementMode,
    participantCount: params.participantCount,
    channelCount: params.channelCount,
    underlyingPaymentCount: params.underlyingPaymentCount,
    grossValueRaw: params.grossValueRaw.toString(),
    grossValueFormatted: `${formatAmount(
      params.grossValueRaw,
      params.decimals
    )} ${params.tokenSymbol}`,
    settlementTransactionCount: params.signatures.length,
    signatures: params.signatures,
    explorerLinks: params.signatures.map((signature) => explorerUrl(signature)),
    serializedTransactionBytes: params.serializedTransactionBytes,
    totalSerializedTransactionBytes: params.serializedTransactionBytes.reduce(
      (sum, value) => sum + value,
      0
    ),
    signedMessageBytes: params.signedMessageBytes,
    signatureCount: params.signatureCount,
    participantBalanceWrites: params.participantBalanceWrites,
    channelStateWrites: params.channelStateWrites,
    baselineModel: savings.baselineModel,
    savings,
    notes: params.notes ?? [],
    requestedShape: params.requestedShape,
    achievedShape: params.achievedShape,
  };
}

function logSavingsComparison(
  totalCommitments: number,
  agonTransactionCount: number,
  agonDescription: string
): void {
  const x402Cost = totalCommitments * X402_SOLANA_COST_PER_TX_USD;
  const agonCost = agonTransactionCount * X402_SOLANA_COST_PER_TX_USD;
  const savings = x402Cost - agonCost;
  const savedTransactions = totalCommitments - agonTransactionCount;
  const reductionPercent = (savedTransactions / totalCommitments) * 100;
  const compressionRatio = totalCommitments / agonTransactionCount;

  logStep(
    `  Traditional x402-style onchain baseline: ${totalCommitments.toLocaleString(
      "en-US"
    )} txs ~= ${formatUsd(x402Cost)} at ${formatUsd(
      X402_SOLANA_COST_PER_TX_USD
    )}/tx`
  );
  logStep(
    `  Agon settlement path: ${agonTransactionCount.toLocaleString(
      "en-US"
    )} tx${
      agonTransactionCount === 1 ? "" : "s"
    } (${agonDescription}) ~= ${formatUsd(agonCost)}`
  );
  logStep(
    `  Estimated savings: ${formatUsd(
      savings
    )}, ${savedTransactions.toLocaleString(
      "en-US"
    )} fewer txs, ${reductionPercent.toFixed(
      5
    )}% reduction, ${formatCompressionRatio(compressionRatio)}x compression`
  );
}

function logSection(title: string): void {
  console.log("");
  console.log("=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

function logStep(message: string): void {
  console.log(`[demo] ${message}`);
}

function explorerUrl(signature: string): string {
  return buildExplorerUrl(signature, "devnet");
}

async function fetchSerializedTransactionBytes(
  connection: Connection,
  signature: string
): Promise<number> {
  const response = await (connection as any)._rpcRequest("getTransaction", [
    signature,
    {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  const encoded = response?.result?.transaction;
  if (!Array.isArray(encoded) || typeof encoded[0] !== "string") {
    throw new Error(`Unable to fetch raw transaction bytes for ${signature}`);
  }
  return Buffer.from(encoded[0], "base64").length;
}

async function selectFeeSponsor(
  connection: Connection,
  candidates: Keypair[]
): Promise<Keypair> {
  const uniqueCandidates = new Map<string, Keypair>();
  for (const candidate of candidates) {
    uniqueCandidates.set(candidate.publicKey.toBase58(), candidate);
  }

  let bestCandidate: Keypair | null = null;
  let bestBalance = -1;
  for (const candidate of uniqueCandidates.values()) {
    const balance = await connection.getBalance(candidate.publicKey, "confirmed");
    if (balance > bestBalance) {
      bestBalance = balance;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    throw new Error("No fee sponsor candidates were provided");
  }

  return bestCandidate;
}

async function parseProgramEvents(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  signature: string
): Promise<{ name: string; data: any }[]> {
  const transaction = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = transaction?.meta?.logMessages ?? [];
  const parser = new anchor.EventParser(program.programId, program.coder);
  return [...parser.parseLogs(logs)];
}

async function estimateSerializedTransactionBytes(
  connection: Connection,
  feePayer: Keypair,
  transaction: anchor.web3.Transaction,
  extraSigners: Keypair[]
): Promise<number> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(feePayer);
  if (extraSigners.length > 0) {
    transaction.partialSign(...extraSigners);
  }
  return transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: false,
  }).length;
}

async function sendLegacyTransaction(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(feePayer, ...extraSigners);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      preflightCommitment: "confirmed",
    }
  );
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

async function createLookupTableForAddresses(
  connection: Connection,
  authority: Keypair,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const recentSlotBackoffs = [5, 10, 20, 40];
  let lookupTableAddress: PublicKey | null = null;
  let created = false;
  let lastError: unknown = null;

  for (const backoff of recentSlotBackoffs) {
    const finalizedSlot = await connection.getSlot("finalized");
    const recentSlot = Math.max(0, finalizedSlot - backoff);
    const [createIx, candidateLookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: authority.publicKey,
        payer: payer.publicKey,
        recentSlot,
      });
    lookupTableAddress = candidateLookupTableAddress;

    try {
      await sendLegacyTransaction(
        connection,
        payer,
        [createIx],
        payer.publicKey.equals(authority.publicKey) ? [] : [authority]
      );
      created = true;
      break;
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      if (!message.includes("not a recent slot")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!created || !lookupTableAddress) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to create lookup table with a recent finalized slot");
  }

  const chunkSize = 20;
  let lastExtendObservedSlot = await connection.getSlot("confirmed");
  for (let offset = 0; offset < addresses.length; offset += chunkSize) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addresses.slice(offset, offset + chunkSize),
    });
    await sendLegacyTransaction(
      connection,
      payer,
      [extendIx],
      payer.publicKey.equals(authority.publicKey) ? [] : [authority]
    );
    lastExtendObservedSlot = await connection.getSlot("confirmed");
  }

  // Newly extended lookup-table addresses are not reliably usable until the
  // cluster advances beyond the slot that observed the last extension.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const currentSlot = await connection.getSlot("confirmed");
    if (currentSlot > lastExtendObservedSlot) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const lookupTable = (
    await connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    })
  ).value;
  if (!lookupTable) {
    throw new Error("Lookup table was created but could not be fetched");
  }
  return lookupTable;
}

async function estimateVersionedTransactionBytes(params: {
  connection: Connection;
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  extraSigners?: Keypair[];
}): Promise<number> {
  const { blockhash } = await params.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: params.feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.feePayer, ...(params.extraSigners ?? [])]);
  return transaction.serialize().length;
}

async function sendVersionedTransaction(params: {
  connection: Connection;
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  extraSigners?: Keypair[];
}): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await params.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: params.feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.feePayer, ...(params.extraSigners ?? [])]);
  const signature = await params.connection.sendRawTransaction(
    transaction.serialize(),
    {
      preflightCommitment: "confirmed",
    }
  );
  await params.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

function getParticipantTokenBalance(
  participant: any,
  tokenId: number
): TokenBalanceView {
  const balance = participant.tokenBalances.find(
    (entry: any) => entry.tokenId === tokenId
  );
  return {
    available: balance?.availableBalance?.toNumber?.() ?? 0,
    withdrawing: balance?.withdrawingBalance?.toNumber?.() ?? 0,
  };
}

async function fetchInternalBalance(
  program: Program<AgonProtocol>,
  wallet: DemoWallet,
  tokenId: number
): Promise<TokenBalanceView> {
  wallet.participantPda = findParticipantPda(
    program.programId,
    wallet.keypair.publicKey
  );
  const participant = await program.account.participantAccount.fetch(
    wallet.participantPda
  );
  const participantOwner = new PublicKey(participant.owner.toString());
  if (!participantOwner.equals(wallet.keypair.publicKey)) {
    throw new Error(
      `Participant owner mismatch for ${
        wallet.name
      }: on-chain owner ${participantOwner.toString()} does not match wallet ${wallet.keypair.publicKey.toString()}`
    );
  }
  wallet.participantId = participant.participantId;
  return getParticipantTokenBalance(participant, tokenId);
}

async function fetchExternalBalance(
  provider: anchor.AnchorProvider,
  tokenAccount: PublicKey
): Promise<bigint> {
  return (await getAccount(provider.connection, tokenAccount)).amount;
}

async function saveRunManifest(
  outputPath: string,
  content: Record<string, unknown>
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function shouldLogProgress(
  completed: number,
  total: number,
  frequency: number
): boolean {
  return completed === total || completed === 1 || completed % frequency === 0;
}

function createSessionNonce(offset: number): number {
  return Math.floor(Date.now() / 1000) + offset;
}

function loadKeypair(secretPath: string): Keypair {
  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(secretPath, "utf8"))
  );
  return Keypair.fromSecretKey(secretKey);
}

async function createWalletFiles(
  count: number,
  repoRoot: string
): Promise<{ runId: string; walletDir: string; wallets: DemoWallet[] }> {
  const names = [
    "Alice",
    "Bob",
    "Carol",
    "Dave",
    "Erin",
    "Frank",
    "Grace",
    "Heidi",
    "Ivan",
    "Judy",
  ];
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const walletDir = path.join(repoRoot, "keys", "agon-protocol-demo", runId);
  fs.mkdirSync(walletDir, { recursive: true });
  const wallets: DemoWallet[] = [];
  for (let index = 0; index < count; index += 1) {
    const keypair = Keypair.generate();
    const fileName = `${String(index + 1).padStart(2, "0")}-${names[
      index
    ].toLowerCase()}.json`;
    const secretPath = path.join(walletDir, fileName);
    fs.writeFileSync(secretPath, JSON.stringify(Array.from(keypair.secretKey)));
    wallets.push({
      name: names[index],
      keypair,
      secretPath,
      participantPda: PublicKey.default,
      participantId: -1,
      tokenAccount: PublicKey.default,
    });
  }
  return { runId, walletDir, wallets };
}

async function loadWalletsFromManifest(
  manifestPath: string,
  walletCount: number,
  repoRoot: string
): Promise<{ runId: string; walletDir: string; wallets: DemoWallet[] }> {
  const resolvedManifestPath = resolveInputPath(repoRoot, manifestPath);
  const manifest = JSON.parse(
    fs.readFileSync(resolvedManifestPath, "utf8")
  ) as DemoRunManifest;

  if (
    !Array.isArray(manifest.wallets) ||
    manifest.wallets.length < walletCount
  ) {
    throw new Error(
      `Manifest ${resolvedManifestPath} only contains ${
        manifest.wallets?.length ?? 0
      } wallets, but ${walletCount} are required`
    );
  }

  const wallets: DemoWallet[] = manifest.wallets
    .slice(0, walletCount)
    .map((entry) => {
      const secretPath = resolveInputPath(repoRoot, entry.secretPath);
      if (!fs.existsSync(secretPath)) {
        throw new Error(`Wallet secret file not found: ${secretPath}`);
      }
      const keypair = loadKeypair(secretPath);
      if (entry.publicKey && entry.publicKey !== keypair.publicKey.toString()) {
        throw new Error(
          `Manifest public key mismatch for ${entry.name}: expected ${
            entry.publicKey
          }, found ${keypair.publicKey.toString()}`
        );
      }
      return {
        name: entry.name,
        keypair,
        secretPath,
        // Re-derive participant state from the current program at runtime.
        participantPda: PublicKey.default,
        participantId: -1,
        tokenAccount: entry.tokenAccount
          ? new PublicKey(entry.tokenAccount)
          : PublicKey.default,
      };
    });

  return {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    walletDir: path.dirname(wallets[0].secretPath),
    wallets,
  };
}

function selectActiveWallets(
  wallets: DemoWallet[],
  activeWalletNames: string[] | null
): DemoWallet[] {
  if (!activeWalletNames || activeWalletNames.length === 0) {
    return wallets;
  }

  const byName = new Map(wallets.map((wallet) => [wallet.name, wallet]));
  const selected = activeWalletNames.map((name) => {
    const wallet = byName.get(name);
    if (!wallet) {
      throw new Error(
        `Active wallet '${name}' was not found in the loaded manifest`
      );
    }
    return wallet;
  });

  if (selected.length < 6) {
    throw new Error(
      `At least 6 active wallets are required, but only ${selected.length} were configured`
    );
  }

  return selected;
}

function loadProgram(provider: anchor.AnchorProvider): Program<AgonProtocol> {
  const idlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "agon_protocol.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  return new Program(idl as AgonProtocol, provider);
}

function createWallet(payer: Keypair): anchor.Wallet & { payer: Keypair } {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (transaction: any) => {
      if ("version" in transaction) {
        transaction.sign([payer]);
      } else {
        transaction.partialSign(payer);
      }
      return transaction;
    },
    signAllTransactions: async (transactions: any[]) =>
      Promise.all(
        transactions.map(async (transaction) => {
          if ("version" in transaction) {
            transaction.sign([payer]);
          } else {
            transaction.partialSign(payer);
          }
          return transaction;
        })
      ),
  };
}

function loadProvider(): anchor.AnchorProvider {
  const rpcEndpoint =
    process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", "devnet-deployer.json");

  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet file not found. Set ANCHOR_WALLET or create ${walletPath}`
    );
  }

  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8"))
  );
  const payer = Keypair.fromSecretKey(secretKey);
  const wallet = createWallet(payer);
  const connection = new Connection(rpcEndpoint, "confirmed");

  return new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

async function ensureProgramReady(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  options: CliOptions
): Promise<{
  chainId: number;
  messageDomain: Buffer;
  feeRecipient: PublicKey;
  vaultTokenAccount: PublicKey;
  decimals: number;
}> {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(
    globalConfigPda
  );
  const tokenRegistry = await program.account.tokenRegistry.fetch(
    tokenRegistryPda
  );
  const tokenEntry = tokenRegistry.tokens.find(
    (entry: any) => entry.id === options.tokenId
  );
  if (!tokenEntry) {
    throw new Error(
      `Token id ${options.tokenId} is not allowlisted on-chain. Run deployment with AGON_ALLOWLIST_TOKENS first.`
    );
  }
  const onChainMint = new PublicKey(tokenEntry.mint.toString());
  if (!onChainMint.equals(options.tokenMint)) {
    throw new Error(
      `Token id ${
        options.tokenId
      } points to ${onChainMint.toString()}, not ${options.tokenMint.toString()}`
    );
  }
  const mintInfo = await getMint(provider.connection, options.tokenMint);
  return {
    chainId: globalConfig.chainId,
    messageDomain: Buffer.from(globalConfig.messageDomain),
    feeRecipient: new PublicKey(globalConfig.feeRecipient.toString()),
    vaultTokenAccount: findVaultTokenAccountPda(
      program.programId,
      options.tokenId
    ),
    decimals: mintInfo.decimals,
  };
}

async function fundDemoWallets(
  provider: anchor.AnchorProvider,
  deployer: Keypair,
  wallets: DemoWallet[],
  mint: PublicKey,
  decimals: number,
  solPerWallet: number,
  tokensPerWallet: number
): Promise<void> {
  const rawTokensPerWallet = BigInt(toRawAmount(tokensPerWallet, decimals));
  const targetLamports = Math.round(solPerWallet * LAMPORTS_PER_SOL);
  const deployerTokenAccount = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      deployer.publicKey
    )
  ).address;
  const deployerTokenBalance = (
    await getAccount(provider.connection, deployerTokenAccount)
  ).amount;
  const requiredTokenBalance = rawTokensPerWallet * BigInt(wallets.length);
  if (deployerTokenBalance < requiredTokenBalance) {
    throw new Error(
      `Deployer token account ${deployerTokenAccount.toString()} only holds ${formatAmount(
        deployerTokenBalance,
        decimals
      )}, but ${formatAmount(
        requiredTokenBalance,
        decimals
      )} is required to seed ${wallets.length} wallets.`
    );
  }

  for (const wallet of wallets) {
    logStep(
      `Ensuring ${wallet.name} has ${solPerWallet} SOL and ${tokensPerWallet} tokens`
    );
    const currentLamports = await provider.connection.getBalance(
      wallet.keypair.publicKey,
      "confirmed"
    );
    if (currentLamports < targetLamports) {
      const solSignature = await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: deployer.publicKey,
            toPubkey: wallet.keypair.publicKey,
            lamports: targetLamports - currentLamports,
          })
        ),
        [deployer]
      );
      logStep(`  SOL top-up: ${solSignature}`);
    } else {
      logStep(
        `  SOL already sufficient: ${
          currentLamports / LAMPORTS_PER_SOL
        } available`
      );
    }

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      wallet.keypair.publicKey
    );
    wallet.tokenAccount = tokenAccount.address;

    const currentTokenBalance = (
      await getAccount(provider.connection, tokenAccount.address)
    ).amount;
    if (currentTokenBalance < rawTokensPerWallet) {
      const tokenSignature = await transfer(
        provider.connection,
        deployer,
        deployerTokenAccount,
        tokenAccount.address,
        deployer,
        rawTokensPerWallet - currentTokenBalance
      );
      logStep(`  Token top-up: ${tokenSignature}`);
    } else {
      logStep(
        `  Token balance already sufficient: ${formatAmount(
          currentTokenBalance,
          decimals
        )}`
      );
    }
  }
}

async function ensureWalletTokenAccounts(
  provider: anchor.AnchorProvider,
  deployer: Keypair,
  wallets: DemoWallet[],
  mint: PublicKey
): Promise<void> {
  for (const wallet of wallets) {
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      wallet.keypair.publicKey
    );
    wallet.tokenAccount = tokenAccount.address;
  }
}

async function ensureParticipants(
  program: Program<AgonProtocol>,
  feeRecipient: PublicKey,
  wallets: DemoWallet[],
  skipInitialization: boolean
): Promise<void> {
  const globalConfig = findGlobalConfigPda(program.programId);
  for (const wallet of wallets) {
    wallet.participantPda = findParticipantPda(
      program.programId,
      wallet.keypair.publicKey
    );
    try {
      const participant = await program.account.participantAccount.fetch(
        wallet.participantPda
      );
      const participantOwner = new PublicKey(participant.owner.toString());
      if (!participantOwner.equals(wallet.keypair.publicKey)) {
        throw new Error(
          `Participant PDA ${wallet.participantPda.toString()} belongs to ${participantOwner.toString()}, not ${wallet.keypair.publicKey.toString()}`
        );
      }
      wallet.participantId = participant.participantId;
      logStep(`Reused ${wallet.name} as participant ${wallet.participantId}`);
    } catch {
      if (skipInitialization) {
        throw new Error(
          `Participant ${wallet.name} is not initialized on-chain, but AGON_DEMO_SKIP_PARTICIPANT_INIT is enabled`
        );
      }
      const signature = await program.methods
        .initializeParticipant()
        .accounts({
          globalConfig,
          participantAccount: wallet.participantPda,
          feeRecipient,
          owner: wallet.keypair.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([wallet.keypair])
        .rpc();
      const participant = await program.account.participantAccount.fetch(
        wallet.participantPda
      );
      wallet.participantId = participant.participantId;
      logStep(
        `Registered ${wallet.name} as participant ${wallet.participantId} (${signature})`
      );
    }
  }
}

async function depositForWallet(
  program: Program<AgonProtocol>,
  wallet: DemoWallet,
  tokenId: number,
  amount: number,
  vaultTokenAccount: PublicKey
): Promise<string> {
  wallet.participantPda = findParticipantPda(
    program.programId,
    wallet.keypair.publicKey
  );
  try {
    return await program.methods
      .deposit(tokenId, new anchor.BN(amount))
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        participantAccount: wallet.participantPda,
        ownerTokenAccount: wallet.tokenAccount,
        vaultTokenAccount,
        owner: wallet.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([wallet.keypair])
      .rpc();
  } catch (error) {
    throw new Error(
      `Deposit failed for ${
        wallet.name
      } (owner=${wallet.keypair.publicKey.toString()}, participantPda=${wallet.participantPda.toString()}, tokenAccount=${wallet.tokenAccount.toString()}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function ensureDeposits(
  program: Program<AgonProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  vaultTokenAccount: PublicKey,
  depositPlan: Record<string, number>,
  skipDeposits: boolean
): Promise<void> {
  logSection("Deposits");
  if (skipDeposits) {
    logStep("Skipping deposits and reusing current internal balances");
    return;
  }

  for (const wallet of wallets) {
    const targetAmount = depositPlan[wallet.name] ?? 0;
    if (targetAmount <= 0) {
      continue;
    }

    const targetRaw = toRawAmount(targetAmount, decimals);
    const currentBalance = await fetchInternalBalance(program, wallet, tokenId);
    if (currentBalance.available >= targetRaw) {
      logStep(
        `${wallet.name} already has ${formatAmount(
          currentBalance.available,
          decimals
        )} ${tokenSymbol} internally`
      );
      continue;
    }

    const topUpAmount = targetRaw - currentBalance.available;
    const signature = await depositForWallet(
      program,
      wallet,
      tokenId,
      topUpAmount,
      vaultTokenAccount
    );
    logStep(
      `${wallet.name} deposited ${formatAmount(
        topUpAmount,
        decimals
      )} ${tokenSymbol} (${signature})`
    );
  }
}

async function ensureChannel(
  program: Program<AgonProtocol>,
  payer: DemoWallet,
  payee: DemoWallet,
  tokenId: number
): Promise<PublicKey> {
  const channelPda = findChannelPda(
    program.programId,
    payer.participantId,
    payee.participantId,
    tokenId
  );
  try {
    await program.account.channelState.fetch(channelPda);
    return channelPda;
  } catch {
    const existingAccount = await program.provider.connection.getAccountInfo(
      channelPda
    );
    if (existingAccount) {
      throw new Error(
        `Channel ${channelPda.toString()} for ${payer.name} -> ${
          payee.name
        } (token ${tokenId}) already exists on-chain but could not be decoded by the current program layout. Use a fresh wallet manifest or rotate participants before rerunning the demo.`
      );
    }
    const signature = await program.methods
      .createChannel(tokenId, null)
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        payerAccount: payer.participantPda,
        payeeAccount: payee.participantPda,
        payeeOwner: payee.keypair.publicKey,
        channelState: channelPda,
        owner: payer.keypair.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer.keypair, payee.keypair])
      .rpc();
    logStep(
      `Created channel ${payer.name} -> ${payee.name} for token ${tokenId} (${signature})`
    );
    return channelPda;
  }
}

async function logScenarioEvents(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  signature: string
): Promise<void> {
  const events = await parseProgramEvents(provider, program, signature);
  if (events.length === 0) {
    logStep("  No Anchor events parsed from transaction logs.");
    return;
  }
  for (const event of events) {
    logStep(`  Event ${event.name}: ${JSON.stringify(event.data)}`);
  }
}

async function runSingleCommitmentScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payer: DemoWallet,
  payee: DemoWallet,
  commitmentCount: number,
  amountPerCommitment: number,
  logEvery: number
): Promise<ScenarioResult> {
  logSection("Scenario 1/5 - Latest Commitment Settlement");
  const channelPda = await ensureChannel(program, payer, payee, tokenId);
  const channelBefore = await program.account.channelState.fetch(channelPda);
  const payerBefore = await fetchInternalBalance(program, payer, tokenId);
  const payeeBefore = await fetchInternalBalance(program, payee, tokenId);
  const rawAmount = toRawAmount(amountPerCommitment, decimals);
  const totalUnderlyingPayments = commitmentCount;
  const priorSettledAmount = channelBefore.settledCumulative.toNumber();
  const finalCommittedAmount =
    priorSettledAmount + rawAmount * totalUnderlyingPayments;
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: [
      {
        payer,
        payee,
        committedAmount: finalCommittedAmount,
        tokenId,
      },
    ],
  });
  const message = createCommitmentMessage({
    payerId: channelBefore.payerId,
    payeeId: channelBefore.payeeId,
    committedAmount: finalCommittedAmount,
    tokenId,
    messageDomain,
  });
  const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: payer.keypair.secretKey,
    message,
  });
  const latestSignature = await program.methods
    .settleIndividual()
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      payerAccount: payer.participantPda,
      payeeAccount: payee.participantPda,
      channelState: channelPda,
      submitter: payee.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .preInstructions([ed25519Instruction])
    .signers([payee.keypair])
    .rpc();
  const serializedTxBytes = await fetchSerializedTransactionBytes(
    provider.connection,
    latestSignature
  );
  if (shouldLogProgress(1, 1, logEvery)) {
    logStep(
      `  Settled the latest cumulative commitment in 1 tx (latest tx: ${latestSignature})`
    );
  }

  const channelAfter = await program.account.channelState.fetch(channelPda);
  const payerAfter = await fetchInternalBalance(program, payer, tokenId);
  const payeeAfter = await fetchInternalBalance(program, payee, tokenId);
  logStep(
    `${payer.name} sent ${totalUnderlyingPayments.toLocaleString(
      "en-US"
    )} offchain payments to ${payee.name} at ${formatAmount(
      rawAmount,
      decimals
    )} ${tokenSymbol} each`
  );
  logStep(
    `${payee.name} settled the latest cumulative commitment for ${formatAmount(
      rawAmount * totalUnderlyingPayments,
      decimals
    )} ${tokenSymbol} in 1 onchain tx`
  );
  logSignedCommitmentPreview(signedCommitmentPreview);
  logSavingsComparison(
    totalUnderlyingPayments,
    1,
    "1 latest commitment settlement"
  );
  logStep(
    `  ${payer.name} internal: ${formatAmount(
      payerBefore.available,
      decimals
    )} -> ${formatAmount(payerAfter.available, decimals)}`
  );
  logStep(
    `  ${payee.name} internal: ${formatAmount(
      payeeBefore.available,
      decimals
    )} -> ${formatAmount(payeeAfter.available, decimals)}`
  );
  logStep(
    `  Channel settled cumulative: ${formatAmount(
      channelBefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(channelAfter.settledCumulative.toNumber(), decimals)}`
  );
  logStep(`  Explorer: ${explorerUrl(latestSignature)}`);
  await logScenarioEvents(provider, program, latestSignature);
  return {
    primarySignature: latestSignature,
    benchmark: createBenchmarkScenario({
      id: "singleCommitment",
      title: "Scenario 1/5 - Latest Commitment Settlement",
      settlementMode: "latest-commitment",
      participantCount: 2,
      channelCount: 1,
      underlyingPaymentCount: totalUnderlyingPayments,
      grossValueRaw: rawAmount * totalUnderlyingPayments,
      decimals,
      tokenSymbol,
      signatures: [latestSignature],
      serializedTransactionBytes: [serializedTxBytes],
      signedMessageBytes: message.length,
      signatureCount: 1,
      participantBalanceWrites: 2,
      channelStateWrites: 1,
      notes: [
        "One latest cumulative commitment replaces exact-payment settlement on the hot path.",
      ],
    }),
  };
}

async function runBatchCommitmentScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payers: DemoWallet[],
  payee: DemoWallet,
  batchCount: number,
  batchSize: number,
  amountPerCommitment: number,
  logEvery: number
): Promise<ScenarioResult> {
  logSection("Scenario 2/5 - Commitment Bundle Settlement");
  const selectedPayers = payers.slice(0, batchCount);
  const rawAmount = toRawAmount(amountPerCommitment, decimals);
  const totalUnderlyingPayments = selectedPayers.length * batchSize;
  const bundleTxCount = Math.max(
    1,
    Math.ceil(selectedPayers.length / MAX_BUNDLE_CHANNELS_PER_TX)
  );
  const payeeBefore = await fetchInternalBalance(program, payee, tokenId);
  const payerBalancesBefore = await Promise.all(
    selectedPayers.map((payer) => fetchInternalBalance(program, payer, tokenId))
  );
  const channelsBefore = await Promise.all(
    selectedPayers.map(async (payer, index) => {
      const channelPda = await ensureChannel(program, payer, payee, tokenId);
      const channel = await program.account.channelState.fetch(channelPda);
      return {
        payer,
        channelPda,
        channel,
        committedAmount:
          channel.settledCumulative.toNumber() + rawAmount * batchSize,
      };
    })
  );
  const commitmentBundlePreview = buildCommitmentBundlePayloadPreview({
    messageDomain,
    decimals,
    tokenId,
    tokenSymbol,
    payee,
    inputs: channelsBefore.map(
      ({ payer, channel, committedAmount }) => ({
        payer,
        payee,
        committedAmount,
        tokenId,
      })
    ),
  });
  const channelChunks: (typeof channelsBefore)[] = [];
  for (
    let index = 0;
    index < channelsBefore.length;
    index += MAX_BUNDLE_CHANNELS_PER_TX
  ) {
    channelChunks.push(
      channelsBefore.slice(index, index + MAX_BUNDLE_CHANNELS_PER_TX)
    );
  }

  const signatures: string[] = [];
  for (let chunkIndex = 0; chunkIndex < channelChunks.length; chunkIndex += 1) {
    const chunk = channelChunks[chunkIndex];
    const bundleEntries = chunk.map(
      ({ payer, channel, committedAmount }) => ({
        signer: payer.keypair,
        message: createCommitmentMessage({
          payerId: channel.payerId,
          payeeId: channel.payeeId,
          committedAmount,
          tokenId,
          messageDomain,
        }),
      })
    );
    const chunkSignature = await program.methods
      .settleCommitmentBundle(bundleEntries.length)
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        payeeAccount: payee.participantPda,
        submitter: payee.keypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(
        chunk.flatMap(({ payer, channelPda }) => [
          { pubkey: payer.participantPda, isSigner: false, isWritable: true },
          { pubkey: channelPda, isSigner: false, isWritable: true },
        ])
      )
      .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
      .signers([payee.keypair])
      .rpc();
    signatures.push(chunkSignature);
    if (shouldLogProgress(chunkIndex + 1, channelChunks.length, logEvery)) {
      logStep(
        `  Settled bundle chunk ${chunkIndex + 1}/${channelChunks.length} (${
          chunk.length
        } channels, latest tx: ${chunkSignature})`
      );
    }
  }

  const totalAmount = rawAmount * totalUnderlyingPayments;
  const channelsAfter = await Promise.all(
    channelsBefore.map(async ({ channelPda }) =>
      program.account.channelState.fetch(channelPda)
    )
  );
  const payerBalancesAfter = await Promise.all(
    selectedPayers.map((payer) => fetchInternalBalance(program, payer, tokenId))
  );
  const payeeAfter = await fetchInternalBalance(program, payee, tokenId);
  logStep(
    `${
      selectedPayers.length
    } buyers streamed ${totalUnderlyingPayments.toLocaleString(
      "en-US"
    )} offchain payments to ${
      payee.name
    }, one latest commitment per unilateral channel`
  );
  logStep(
    `${payee.name} settled those ${
      selectedPayers.length
    } channel commitments in ${bundleTxCount} bundle tx${
      bundleTxCount === 1 ? "" : "s"
    } for ${formatAmount(totalAmount, decimals)} at ${formatAmount(
      rawAmount,
      decimals
    )} ${tokenSymbol} per underlying payment`
  );
  logStep(
    `  Each latest commitment represented ${batchSize} offchain payments`
  );
  logCommitmentBundlePayloadPreview(commitmentBundlePreview);
  logSavingsComparison(
    totalUnderlyingPayments,
    bundleTxCount,
    `${bundleTxCount} bundled commitment settlement tx${
      bundleTxCount === 1 ? "" : "s"
    }`
  );
  selectedPayers.forEach((payer, index) => {
    logStep(
      `  ${payer.name} internal: ${formatAmount(
        payerBalancesBefore[index].available,
        decimals
      )} -> ${formatAmount(payerBalancesAfter[index].available, decimals)}`
    );
  });
  logStep(
    `  ${payee.name} internal: ${formatAmount(
      payeeBefore.available,
      decimals
    )} -> ${formatAmount(payeeAfter.available, decimals)}`
  );
  channelsBefore.forEach(({ payer, channel }, index) => {
    logStep(
      `  Channel ${payer.name}->${
        payee.name
      } settled cumulative: ${formatAmount(
        channel.settledCumulative.toNumber(),
        decimals
      )} -> ${formatAmount(
        channelsAfter[index].settledCumulative.toNumber(),
        decimals
      )}`
    );
  });
  const serializedTransactionBytes = await Promise.all(
    signatures.map((signature) =>
      fetchSerializedTransactionBytes(provider.connection, signature)
    )
  );
  const latestSignature = signatures[signatures.length - 1];
  logStep(`  Explorer: ${explorerUrl(latestSignature)}`);
  await logScenarioEvents(provider, program, latestSignature);
  return {
    primarySignature: latestSignature,
    benchmark: createBenchmarkScenario({
      id: "batchCommitment",
      title: "Scenario 2/5 - Commitment Bundle Settlement",
      settlementMode: "bundle",
      participantCount: selectedPayers.length + 1,
      channelCount: selectedPayers.length,
      underlyingPaymentCount: totalUnderlyingPayments,
      grossValueRaw: totalAmount,
      decimals,
      tokenSymbol,
      signatures,
      serializedTransactionBytes,
      signedMessageBytes: channelsBefore.reduce(
        (sum, { channel, committedAmount }) =>
          sum +
          createCommitmentMessage({
            payerId: channel.payerId,
            payeeId: channel.payeeId,
            committedAmount,
            tokenId,
            messageDomain,
          }).length,
        0
      ),
      signatureCount: channelsBefore.length,
      participantBalanceWrites: selectedPayers.length + 1,
      channelStateWrites: channelsBefore.length,
      notes: [
        "Many unilateral latest commitments settle in payee-side bundle transactions.",
      ],
    }),
  };
}

async function runUnilateralClearingScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payer: DemoWallet,
  payeeA: DemoWallet,
  payeeB: DemoWallet,
  payeeACommitmentCount: number,
  payeeBCommitmentCount: number,
  amountPerCommitment: number,
  requestedLockAmount: number
): Promise<ScenarioResult> {
  logSection("Scenario 3/5 - Clearing Round (Single Payer)");
  const channelA = await ensureChannel(program, payer, payeeA, tokenId);
  const channelB = await ensureChannel(program, payer, payeeB, tokenId);
  const channelABefore = await program.account.channelState.fetch(channelA);
  const channelBBefore = await program.account.channelState.fetch(channelB);
  const rawAmountPerCommitment = toRawAmount(amountPerCommitment, decimals);
  const settleAAmount = rawAmountPerCommitment * payeeACommitmentCount;
  const settleBAmount = rawAmountPerCommitment * payeeBCommitmentCount;
  const lockAmount = Math.min(
    toRawAmount(requestedLockAmount, decimals),
    settleAAmount
  );
  const payerBefore = await fetchInternalBalance(program, payer, tokenId);
  const payeeABefore = await fetchInternalBalance(program, payeeA, tokenId);
  const payeeBBefore = await fetchInternalBalance(program, payeeB, tokenId);
  const lockSignature = await program.methods
    .lockChannelFunds(tokenId, new anchor.BN(lockAmount))
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerAccount: payer.participantPda,
      payeeAccount: payeeA.participantPda,
      channelState: channelA,
      owner: payer.keypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer.keypair])
    .rpc();
  logStep(
    `Locked ${formatAmount(lockAmount, decimals)} for ${payer.name} -> ${
      payeeA.name
    } (${lockSignature})`
  );
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: [
      {
        payer,
        payee: payeeA,
        committedAmount:
          channelABefore.settledCumulative.toNumber() + rawAmountPerCommitment,
        tokenId,
      },
      {
        payer,
        payee: payeeA,
        committedAmount:
          channelABefore.settledCumulative.toNumber() +
          rawAmountPerCommitment * Math.min(2, payeeACommitmentCount),
        tokenId,
      },
      {
        payer,
        payee: payeeB,
        committedAmount:
          channelBBefore.settledCumulative.toNumber() + rawAmountPerCommitment,
        tokenId,
      },
      {
        payer,
        payee: payeeB,
        committedAmount:
          channelBBefore.settledCumulative.toNumber() +
          rawAmountPerCommitment * Math.min(2, payeeBCommitmentCount),
        tokenId,
      },
    ].slice(
      0,
      Math.min(
        SIGNED_COMMITMENT_PREVIEW_COUNT,
        (payeeACommitmentCount > 1 ? 2 : 1) +
          (payeeBCommitmentCount > 1 ? 2 : 1)
      )
    ),
  });
  const roundBlocks: ClearingRoundPreviewBlockInput[] = [
    {
      participant: payer,
      entries: [
        {
          payeeRef: 1,
          payee: payeeA,
          targetCumulative:
            channelABefore.settledCumulative.toNumber() + settleAAmount,
        },
        {
          payeeRef: 2,
          payee: payeeB,
          targetCumulative:
            channelBBefore.settledCumulative.toNumber() + settleBAmount,
        },
      ],
    },
    {
      participant: payeeA,
      entries: [],
    },
    {
      participant: payeeB,
      entries: [],
    },
  ];
  const clearingRoundPreview = buildClearingRoundPayloadPreview({
    messageDomain,
    tokenId,
    tokenSymbol,
    decimals,
    blocks: roundBlocks,
  });
  const message = createClearingRoundMessage({
    tokenId,
    messageDomain,
    blocks: roundBlocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });
  const ed25519Instruction = createMultiSigEd25519Instruction(
    [payer.keypair, payeeA.keypair, payeeB.keypair],
    message
  );
  const signature = await program.methods
    .settleClearingRound()
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      submitter: payer.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts([
      { pubkey: payer.participantPda, isSigner: false, isWritable: true },
      { pubkey: payeeA.participantPda, isSigner: false, isWritable: true },
      { pubkey: payeeB.participantPda, isSigner: false, isWritable: true },
      { pubkey: channelA, isSigner: false, isWritable: true },
      { pubkey: channelB, isSigner: false, isWritable: true },
    ])
    .preInstructions([ed25519Instruction])
    .signers([payer.keypair])
    .rpc();
  const serializedTransactionBytes = await Promise.all([
    fetchSerializedTransactionBytes(provider.connection, lockSignature),
    fetchSerializedTransactionBytes(provider.connection, signature),
  ]);
  const channelAAfter = await program.account.channelState.fetch(channelA);
  const channelBAfter = await program.account.channelState.fetch(channelB);
  const payerAfter = await fetchInternalBalance(program, payer, tokenId);
  const payeeAAfter = await fetchInternalBalance(program, payeeA, tokenId);
  const payeeBAfter = await fetchInternalBalance(program, payeeB, tokenId);
  logStep(
    `${payer.name} cleared ${(
      payeeACommitmentCount + payeeBCommitmentCount
    ).toLocaleString(
      "en-US"
    )} underlying micropayments across 2 unilateral channels totaling ${formatAmount(
      settleAAmount + settleBAmount,
      decimals
    )} at ${formatAmount(rawAmountPerCommitment, decimals)} each`
  );
  logSignedCommitmentPreview(signedCommitmentPreview);
  logClearingRoundPayloadPreview(clearingRoundPreview);
  logSavingsComparison(
    payeeACommitmentCount + payeeBCommitmentCount,
    2,
    "1 lock + 1 single-payer clearing round"
  );
  logStep(
    `  ${payeeA.name} internal: ${formatAmount(
      payeeABefore.available,
      decimals
    )} -> ${formatAmount(payeeAAfter.available, decimals)}`
  );
  logStep(
    `  ${payeeB.name} internal: ${formatAmount(
      payeeBBefore.available,
      decimals
    )} -> ${formatAmount(payeeBAfter.available, decimals)}`
  );
  logStep(
    `  ${payer.name} internal: ${formatAmount(
      payerBefore.available,
      decimals
    )} -> ${formatAmount(payerAfter.available, decimals)}`
  );
  logStep(
    `  Channel ${payer.name}->${payeeA.name}: locked ${formatAmount(
      channelABefore.lockedBalance.toNumber(),
      decimals
    )} -> ${formatAmount(
      channelAAfter.lockedBalance.toNumber(),
      decimals
    )}, settled cumulative ${formatAmount(
      channelABefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(channelAAfter.settledCumulative.toNumber(), decimals)}`
  );
  logStep(
    `  Channel ${payer.name}->${payeeB.name}: settled cumulative ${formatAmount(
      channelBBefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(channelBAfter.settledCumulative.toNumber(), decimals)}`
  );
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);
  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: "unilateralClearing",
      title: "Scenario 3/5 - Clearing Round (Single Payer)",
      settlementMode: "single-payer-clearing",
      participantCount: 3,
      channelCount: 2,
      underlyingPaymentCount:
        payeeACommitmentCount + payeeBCommitmentCount,
      grossValueRaw: settleAAmount + settleBAmount,
      decimals,
      tokenSymbol,
      signatures: [lockSignature, signature],
      serializedTransactionBytes,
      signedMessageBytes: message.length,
      signatureCount: 3,
      participantBalanceWrites: 4,
      channelStateWrites: 3,
      notes: [
        "One collateral lock plus one cooperative clearing round settles two unilateral lanes.",
      ],
    }),
  };
}

async function runBilateralClearingScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  participantA: DemoWallet,
  participantB: DemoWallet,
  forwardCommitmentCount: number,
  reverseCommitmentCount: number,
  amountPerCommitment: number
): Promise<ScenarioResult> {
  logSection("Scenario 4/5 - Clearing Round (Bilateral)");
  const channelAB = await ensureChannel(
    program,
    participantA,
    participantB,
    tokenId
  );
  const channelBA = await ensureChannel(
    program,
    participantB,
    participantA,
    tokenId
  );
  const currentAB = await program.account.channelState.fetch(channelAB);
  const currentBA = await program.account.channelState.fetch(channelBA);
  const beforeA = await fetchInternalBalance(program, participantA, tokenId);
  const beforeB = await fetchInternalBalance(program, participantB, tokenId);
  const rawAmountPerCommitment = toRawAmount(amountPerCommitment, decimals);
  const grossAToB = rawAmountPerCommitment * forwardCommitmentCount;
  const grossBToA = rawAmountPerCommitment * reverseCommitmentCount;
  const netAdjustment = Math.abs(grossAToB - grossBToA);
  const bilateralPreviewInputs: SignedCommitmentPreviewInput[] = [
    {
      payer: participantA,
      payee: participantB,
      committedAmount:
        currentAB.settledCumulative.toNumber() + rawAmountPerCommitment,
      tokenId,
    },
  ];
  if (
    forwardCommitmentCount > 1 &&
    bilateralPreviewInputs.length < SIGNED_COMMITMENT_PREVIEW_COUNT
  ) {
    bilateralPreviewInputs.push({
      payer: participantA,
      payee: participantB,
      committedAmount:
        currentAB.settledCumulative.toNumber() + rawAmountPerCommitment * 2,
      tokenId,
    });
  }
  if (bilateralPreviewInputs.length < SIGNED_COMMITMENT_PREVIEW_COUNT) {
    bilateralPreviewInputs.push({
      payer: participantB,
      payee: participantA,
      committedAmount:
        currentBA.settledCumulative.toNumber() + rawAmountPerCommitment,
      tokenId,
    });
  }
  if (
    reverseCommitmentCount > 1 &&
    bilateralPreviewInputs.length < SIGNED_COMMITMENT_PREVIEW_COUNT
  ) {
    bilateralPreviewInputs.push({
      payer: participantB,
      payee: participantA,
      committedAmount:
        currentBA.settledCumulative.toNumber() + rawAmountPerCommitment * 2,
      tokenId,
    });
  }
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: bilateralPreviewInputs,
  });
  const roundBlocks: ClearingRoundPreviewBlockInput[] = [
    {
      participant: participantA,
      entries: [
        {
          payeeRef: 1,
          payee: participantB,
          targetCumulative: currentAB.settledCumulative.toNumber() + grossAToB,
        },
      ],
    },
    {
      participant: participantB,
      entries: [
        {
          payeeRef: 0,
          payee: participantA,
          targetCumulative: currentBA.settledCumulative.toNumber() + grossBToA,
        },
      ],
    },
  ];
  const clearingRoundPreview = buildClearingRoundPayloadPreview({
    messageDomain,
    tokenId,
    tokenSymbol,
    decimals,
    blocks: roundBlocks,
  });
  const message = createClearingRoundMessage({
    tokenId,
    messageDomain,
    blocks: roundBlocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });
  const signature = await program.methods
    .settleClearingRound()
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      submitter: participantA.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts([
      {
        pubkey: participantA.participantPda,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: participantB.participantPda,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: channelAB, isSigner: false, isWritable: true },
      { pubkey: channelBA, isSigner: false, isWritable: true },
    ])
    .preInstructions([
      createMultiSigEd25519Instruction(
        [participantA.keypair, participantB.keypair],
        message
      ),
    ])
    .signers([participantA.keypair])
    .rpc();
  const serializedTxBytes = await fetchSerializedTransactionBytes(
    provider.connection,
    signature
  );
  const afterA = await fetchInternalBalance(program, participantA, tokenId);
  const afterB = await fetchInternalBalance(program, participantB, tokenId);
  const afterChannelAB = await program.account.channelState.fetch(channelAB);
  const afterChannelBA = await program.account.channelState.fetch(channelBA);
  logStep(
    `Gross obligations: ${participantA.name} -> ${
      participantB.name
    } ${formatAmount(
      grossAToB,
      decimals
    )} across ${forwardCommitmentCount.toLocaleString(
      "en-US"
    )} underlying micropayments, ${participantB.name} -> ${
      participantA.name
    } ${formatAmount(
      grossBToA,
      decimals
    )} across ${reverseCommitmentCount.toLocaleString(
      "en-US"
    )} underlying micropayments`
  );
  if (netAdjustment === 0) {
    logStep("Net adjustment: none");
  } else if (grossAToB > grossBToA) {
    logStep(
      `Net adjustment: ${participantA.name} -> ${
        participantB.name
      } ${formatAmount(netAdjustment, decimals)}`
    );
  } else {
    logStep(
      `Net adjustment: ${participantB.name} -> ${
        participantA.name
      } ${formatAmount(netAdjustment, decimals)}`
    );
  }
  logSignedCommitmentPreview(signedCommitmentPreview);
  logClearingRoundPayloadPreview(clearingRoundPreview);
  logSavingsComparison(
    forwardCommitmentCount + reverseCommitmentCount,
    1,
    "1 bilateral clearing round"
  );
  logStep(
    `  ${participantA.name} internal: ${formatAmount(
      beforeA.available,
      decimals
    )} -> ${formatAmount(afterA.available, decimals)}`
  );
  logStep(
    `  ${participantB.name} internal: ${formatAmount(
      beforeB.available,
      decimals
    )} -> ${formatAmount(afterB.available, decimals)}`
  );
  logStep(
    `  Channel ${participantA.name}->${
      participantB.name
    }: settled cumulative ${formatAmount(
      currentAB.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(
      afterChannelAB.settledCumulative.toNumber(),
      decimals
    )}`
  );
  logStep(
    `  Channel ${participantB.name}->${
      participantA.name
    }: settled cumulative ${formatAmount(
      currentBA.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(
      afterChannelBA.settledCumulative.toNumber(),
      decimals
    )}`
  );
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);
  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: "bilateralClearing",
      title: "Scenario 4/5 - Clearing Round (Bilateral)",
      settlementMode: "bilateral-clearing",
      participantCount: 2,
      channelCount: 2,
      underlyingPaymentCount:
        forwardCommitmentCount + reverseCommitmentCount,
      grossValueRaw: grossAToB + grossBToA,
      decimals,
      tokenSymbol,
      signatures: [signature],
      serializedTransactionBytes: [serializedTxBytes],
      signedMessageBytes: message.length,
      signatureCount: 2,
      participantBalanceWrites: 2,
      channelStateWrites: 2,
      notes: [
        "Two-way obligations collapse to one cooperative round and only residual net balance changes.",
      ],
    }),
  };
}

async function runMultilateralClearingScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  participants: DemoWallet[],
  channelCount: number,
  edgeCommitmentCount: number,
  amountPerCommitment: number
): Promise<MultilateralScenarioResult> {
  if (participants.length < 3) {
    throw new Error("Multilateral clearing requires at least 3 participants");
  }
  if (channelCount < participants.length) {
    throw new Error(
      "Multilateral clearing scenario requires at least one directed channel per participant"
    );
  }

  logSection("Scenario 5/5 - Clearing Round (Largest Executable v0 + ALT)");
  const orderedPairs = buildOrderedParticipantPairs(participants);
  if (channelCount > orderedPairs.length) {
    throw new Error(
      `Requested ${channelCount} directed channels but only ${orderedPairs.length} unique participant pairs exist`
    );
  }
  const participantBalancesBefore = await Promise.all(
    participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(program, participant, tokenId),
    }))
  );
  const candidateChannelCounts = Array.from(
    { length: channelCount - participants.length + 1 },
    (_, index) => channelCount - index
  );
  let channelEdges:
    | Array<{
        payer: DemoWallet;
        payee: DemoWallet;
        channelPda: PublicKey;
        channel: any;
      }>
    | null = null;
  let roundBlocks: ClearingRoundPreviewBlockInput[] | null = null;
  let clearingRoundPreview: ClearingRoundPayloadPreview | null = null;
  let actualV0AltTxBytes: number | null = null;
  let signature: string | null = null;
  let lastAttemptError: unknown = null;
  const rawAmountPerCommitment = toRawAmount(amountPerCommitment, decimals);
  const submitter = participants[0];
  const providerPayer = (provider.wallet as any).payer as Keypair | undefined;
  const sponsor = await selectFeeSponsor(provider.connection, [
    ...(providerPayer ? [providerPayer] : []),
    ...participants.map((participant) => participant.keypair),
  ]);
  const extraSigners = sponsor.publicKey.equals(submitter.keypair.publicKey)
    ? []
    : [submitter.keypair];
  const grossAmount = rawAmountPerCommitment * edgeCommitmentCount;
  if (!sponsor.publicKey.equals(submitter.keypair.publicKey)) {
    logStep(
      `Using ${sponsor.publicKey.toString()} as the fee sponsor for the multilateral round while ${submitter.name} remains the signed submitter`
    );
  }

  for (const candidateChannelCount of candidateChannelCounts) {
    const selectedPairs = orderedPairs.slice(0, candidateChannelCount);
    const candidateChannelEdges = await Promise.all(
      selectedPairs.map(async ([payer, payee]) => {
        const channelPda = await ensureChannel(program, payer, payee, tokenId);
        const channel = await program.account.channelState.fetch(channelPda);
        return {
          payer,
          payee,
          channelPda,
          channel,
        };
      })
    );
    const candidateRoundBlocks: ClearingRoundPreviewBlockInput[] =
      participants.map((participant) => ({
        participant,
        entries: candidateChannelEdges
          .filter(
            (edge) => edge.payer.participantId === participant.participantId
          )
          .map((edge) => ({
            payeeRef: participants.findIndex(
              (candidate) =>
                candidate.participantId === edge.payee.participantId
            ),
            payee: edge.payee,
            targetCumulative:
              edge.channel.settledCumulative.toNumber() + grossAmount,
          })),
      }));
    const message = createClearingRoundMessage({
      tokenId,
      messageDomain,
      blocks: candidateRoundBlocks.map((block) => ({
        participantId: block.participant.participantId,
        entries: block.entries.map((entry) => ({
          payeeRef: entry.payeeRef,
          targetCumulative: entry.targetCumulative,
        })),
      })),
    });
    const roundSigners = participants.map((participant) => participant.keypair);
    const ed25519Instruction = createMultiSigEd25519Instruction(
      roundSigners,
      message
    );
    const participantAccounts = participants.map((participant) => ({
      pubkey: participant.participantPda,
      isSigner: false,
      isWritable: true,
    }));
    const channelAccounts = candidateRoundBlocks.flatMap((block) =>
      block.entries.map((entry) => {
        const edge = candidateChannelEdges.find(
          (candidate) =>
            candidate.payer.participantId === block.participant.participantId &&
            candidate.payee.participantId ===
              participants[entry.payeeRef]?.participantId
        );
        if (!edge) {
          throw new Error("Unable to resolve clearing-round channel account");
        }
        return {
          pubkey: edge.channelPda,
          isSigner: false,
          isWritable: true,
        };
      })
    );
    const remainingAccounts = [...participantAccounts, ...channelAccounts];
    const clearingRoundInstruction = await program.methods
      .settleClearingRound()
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        submitter: submitter.keypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(remainingAccounts)
      .instruction();
    const lookupTable = await createLookupTableForAddresses(
      provider.connection,
      submitter.keypair,
      sponsor,
      [
        findTokenRegistryPda(program.programId),
        findGlobalConfigPda(program.programId),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...participants.map((participant) => participant.participantPda),
        ...candidateChannelEdges.map((edge) => edge.channelPda),
      ]
    );

    try {
      const candidateTxBytes = await estimateVersionedTransactionBytes({
        connection: provider.connection,
        feePayer: sponsor,
        instructions: [ed25519Instruction, clearingRoundInstruction],
        lookupTables: [lookupTable],
        extraSigners,
      });
      const candidateSignature = await sendVersionedTransaction({
        connection: provider.connection,
        feePayer: sponsor,
        instructions: [ed25519Instruction, clearingRoundInstruction],
        lookupTables: [lookupTable],
        extraSigners,
      });

      channelEdges = candidateChannelEdges;
      roundBlocks = candidateRoundBlocks;
      clearingRoundPreview = buildClearingRoundPayloadPreview({
        messageDomain,
        tokenId,
        tokenSymbol,
        decimals,
        blocks: candidateRoundBlocks,
      });
      actualV0AltTxBytes = candidateTxBytes;
      signature = candidateSignature;
      break;
    } catch (error) {
      lastAttemptError = error;
      if (candidateChannelCount === participants.length) {
        throw error;
      }
    }
  }

  if (
    !channelEdges ||
    !roundBlocks ||
    !clearingRoundPreview ||
    actualV0AltTxBytes === null ||
    !signature
  ) {
    throw lastAttemptError instanceof Error
      ? lastAttemptError
      : new Error("Unable to settle any multilateral clearing round shape");
  }

  const totalUnderlyingCommitments = edgeCommitmentCount * channelEdges.length;
  const totalGrossRouted = grossAmount * channelEdges.length;
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: channelEdges
      .slice(0, Math.min(SIGNED_COMMITMENT_PREVIEW_COUNT, channelEdges.length))
      .map(({ payer, payee, channel }) => ({
        payer,
        payee,
        committedAmount:
          channel.settledCumulative.toNumber() + rawAmountPerCommitment,
        tokenId,
      })),
  });
  const participantBalancesAfter = await Promise.all(
    participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(program, participant, tokenId),
    }))
  );
  const channelEdgesAfter = await Promise.all(
    channelEdges.map(async (edge) => ({
      ...edge,
      afterChannel: await program.account.channelState.fetch(edge.channelPda),
    }))
  );
  const incomingByPayee = new Map<
    number,
    { incomingCount: number; payers: Set<number> }
  >();
  for (const block of roundBlocks) {
    for (const entry of block.entries) {
      const current = incomingByPayee.get(entry.payee.participantId) ?? {
        incomingCount: 0,
        payers: new Set<number>(),
      };
      current.incomingCount += 1;
      current.payers.add(block.participant.participantId);
      incomingByPayee.set(entry.payee.participantId, current);
    }
  }
  const equivalentBundleTxCount = incomingByPayee.size;
  const batchSettlementParticipantWrites = [...incomingByPayee.values()].reduce(
    (sum, stat) => sum + stat.payers.size + 1,
    0
  );
  const multilateralParticipantBalanceWrites = participantBalancesBefore.reduce(
    (sum, { balance }, index) =>
      sum +
      (balance.available === participantBalancesAfter[index].balance.available
        ? 0
        : 1),
    0
  );
  if (channelEdges.length < channelCount) {
    logStep(
      `Requested a ${participants.length}-agent / ${channelCount}-channel flagship round, but the current cluster executed ${channelEdges.length} channels successfully. Falling back to the largest live shape.`
    );
  }
  logStep(
    `Flagship multilateral clearing example: ${edgeCommitmentCount.toLocaleString(
      "en-US"
    )} offchain micropayments on each of ${channelEdges.length} directed channels, ${totalUnderlyingCommitments.toLocaleString(
      "en-US"
    )} total`
  );
  logStep(
    `Gross value routed: ${formatAmount(
      grossAmount,
      decimals
    )} ${tokenSymbol} per channel, ${formatAmount(
      totalGrossRouted,
      decimals
    )} ${tokenSymbol} total at ${formatAmount(
      rawAmountPerCommitment,
      decimals
    )} each`
  );
  logStep(
    `Equivalent bundle-settlement baseline: ${channelEdges.length} latest commitments grouped into ${equivalentBundleTxCount} payee-side bundle tx${
      equivalentBundleTxCount === 1 ? "" : "s"
    }, ${batchSettlementParticipantWrites} participant balance writes, ${channelEdges.length} channel-state updates`
  );
  logStep(
    `Multilateral compression vs bundle settlement: ${formatCompressionRatio(
      equivalentBundleTxCount
    )}x fewer settlement txs (${equivalentBundleTxCount} -> 1), ${formatCompressionRatio(
      channelEdges.length / participants.length
    )}x fewer signed payloads at final settlement (${
      channelEdges.length
    } -> ${participants.length}), ${
      multilateralParticipantBalanceWrites === 0
        ? `participant balance writes eliminated (${batchSettlementParticipantWrites} -> 0)`
        : `${formatCompressionRatio(
            batchSettlementParticipantWrites / multilateralParticipantBalanceWrites
          )}x fewer participant balance writes (${batchSettlementParticipantWrites} -> ${multilateralParticipantBalanceWrites})`
    }`
  );
  logStep(
    `Channel-state writes today: no compression yet (${channelEdges.length} -> ${channelEdges.length}); every unilateral channel still advances in the round.`
  );
  logStep(
    "Net settlement flows submitted onchain: none (perfect multi-party offset)"
  );
  logStep(
    `Result: balances stay flat while all ${channelEdges.length} unilateral channels advance to their latest cumulative commitments`
  );
  logStep(
    `${participants.length}-agent graph compressed into 1 signed multilateral clearing round`
  );
  logStep(
    `  Actual serialized tx size (v0 + ALT, self-funded): ${actualV0AltTxBytes}/${LEGACY_PACKET_DATA_SIZE} bytes`
  );
  logSignedCommitmentPreview(signedCommitmentPreview);
  logClearingRoundPayloadPreview(clearingRoundPreview);
  logSavingsComparison(
    totalUnderlyingCommitments,
    1,
    "1 multilateral clearing round"
  );
  participantBalancesBefore.forEach(({ participant, balance }, index) => {
    logStep(
      `  ${participant.name} internal: ${formatAmount(
        balance.available,
        decimals
      )} -> ${formatAmount(
        participantBalancesAfter[index].balance.available,
        decimals
      )}`
    );
  });
  const channelSamples = channelEdgesAfter
    .slice(0, Math.min(4, channelEdgesAfter.length))
    .map(
      ({ payer, payee, channel, afterChannel }) =>
        `${payer.name}->${payee.name} ${formatAmount(
          channel.settledCumulative.toNumber(),
          decimals
        )} -> ${formatAmount(
          afterChannel.settledCumulative.toNumber(),
          decimals
        )}`
    )
    .join("; ");
  logStep(
    `  Channel states: ${channelEdgesAfter.length} channels advanced; sample ${channelSamples}`
  );
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);
  const achievedShape: BenchmarkShape = {
    participantCount: participants.length,
    channelCount: channelEdges.length,
  };
  const requestedShape: BenchmarkShape = {
    participantCount: participants.length,
    channelCount,
  };
  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: "multilateralClearing",
      title: "Scenario 5/5 - Clearing Round (Largest Executable v0 + ALT)",
      settlementMode: "multilateral-clearing",
      participantCount: participants.length,
      channelCount: channelEdges.length,
      underlyingPaymentCount: totalUnderlyingCommitments,
      grossValueRaw: totalGrossRouted,
      decimals,
      tokenSymbol,
      signatures: [signature],
      serializedTransactionBytes: [actualV0AltTxBytes],
      signedMessageBytes: createClearingRoundMessage({
        tokenId,
        messageDomain,
        blocks: roundBlocks.map((block) => ({
          participantId: block.participant.participantId,
          entries: block.entries.map((entry) => ({
            payeeRef: entry.payeeRef,
            targetCumulative: entry.targetCumulative,
          })),
        })),
      }).length,
      signatureCount: participants.length,
      participantBalanceWrites: multilateralParticipantBalanceWrites,
      channelStateWrites: channelEdges.length,
      requestedShape,
      achievedShape,
      notes: [
        "Current multilateral rounds still pay per-channel state writes, but they compress settlement transactions and signed payloads.",
      ],
    }),
    settledChannelCount: channelEdges.length,
  };
}

async function runLargestExecutableMultilateralScenario(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  participants: DemoWallet[],
  targets: MultilateralSearchTarget,
  edgeCommitmentCount: number,
  amountPerCommitment: number
): Promise<MultilateralScenarioResult> {
  if (participants.length < 3) {
    throw new Error("At least three funded participants are required");
  }

  const candidateShapes: BenchmarkShape[] = [];
  const pushCandidate = (shape: BenchmarkShape): void => {
    if (
      shape.participantCount < 3 ||
      shape.participantCount > participants.length ||
      shape.channelCount < shape.participantCount
    ) {
      return;
    }
    if (
      !candidateShapes.some(
        (candidate) =>
          candidate.participantCount === shape.participantCount &&
          candidate.channelCount === shape.channelCount
      )
    ) {
      candidateShapes.push(shape);
    }
  };

  pushCandidate(targets.overall);
  pushCandidate(targets.balanced);
  for (
    let participantCount = Math.min(
      targets.overall.participantCount,
      participants.length
    );
    participantCount >= 3;
    participantCount -= 1
  ) {
    pushCandidate({
      participantCount,
      channelCount: Math.min(
        targets.overall.channelCount,
        participantCount * (participantCount - 1)
      ),
    });
    pushCandidate({
      participantCount,
      channelCount: Math.min(
        targets.balanced.channelCount,
        participantCount * (participantCount - 1)
      ),
    });
  }

  let lastError: unknown = null;
  for (const shape of candidateShapes) {
    try {
      return await runMultilateralClearingScenario(
        provider,
        program,
        messageDomain,
        tokenId,
        tokenSymbol,
        decimals,
        participants.slice(0, shape.participantCount),
        shape.channelCount,
        edgeCommitmentCount,
        amountPerCommitment
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to find an executable multilateral clearing shape");
}

async function logFinalSummary(
  provider: anchor.AnchorProvider,
  program: Program<AgonProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number
): Promise<void> {
  logSection("Final Summary");
  for (const wallet of wallets) {
    const internalBalance = await fetchInternalBalance(
      program,
      wallet,
      tokenId
    );
    const externalBalance = await fetchExternalBalance(
      provider,
      wallet.tokenAccount
    );
    logStep(
      `${wallet.name} (${wallet.keypair.publicKey.toString()}) participant=${
        wallet.participantId
      } internal=${formatAmount(
        internalBalance.available,
        decimals
      )} ${tokenSymbol} external=${formatAmount(
        externalBalance,
        decimals
      )} ${tokenSymbol}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const deployer = (provider.wallet as any).payer as Keypair;
  if (!deployer) {
    throw new Error("Provider wallet does not expose a payer keypair");
  }
  const network = inferNetwork(provider.connection.rpcEndpoint);
  const clearingCapacitySummary = summarizeClearingRoundCapacity(
    program.programId
  );
  if (network !== "devnet") {
    throw new Error(
      `This showcase is wired for Solana devnet because the provided mint ${options.tokenMint.toString()} is a devnet mint. Connected RPC: ${
        provider.connection.rpcEndpoint
      }`
    );
  }
  const repoRoot = process.cwd();

  logSection("Agon Protocol Demo");
  if (options.configFilePath) {
    logStep(
      `Config file: ${resolveInputPath(repoRoot, options.configFilePath)}`
    );
  }
  logStep(`RPC endpoint: ${provider.connection.rpcEndpoint}`);
  logStep(`Program ID: ${program.programId.toString()}`);
  logStep(`Deployer: ${deployer.publicKey.toString()}`);
  logStep(`Token mint: ${options.tokenMint.toString()}`);
  logStep(`Wallet count: ${options.walletCount}`);

  const readiness = await ensureProgramReady(provider, program, options);
  logStep(`Chain ID: ${readiness.chainId}`);
  logStep(`Message domain: ${trimHex(readiness.messageDomain.toString("hex"))}`);
  logStep(`Fee recipient wallet: ${readiness.feeRecipient.toString()}`);
  logStep(`Vault token account: ${readiness.vaultTokenAccount.toString()}`);
  logStep(`Mint decimals: ${readiness.decimals}`);
  const preparedWallets = options.reuseManifestPath
    ? await loadWalletsFromManifest(
        options.reuseManifestPath,
        options.walletCount,
        repoRoot
      )
    : await createWalletFiles(options.walletCount, repoRoot);
  const { runId, walletDir, wallets: loadedWallets } = preparedWallets;
  const wallets = selectActiveWallets(loadedWallets, options.activeWalletNames);
  if (options.reuseManifestPath) {
    logStep(`Reusing wallet files from ${walletDir}`);
  } else {
    logStep(`Wallet files written to ${walletDir}`);
  }
  if (options.activeWalletNames) {
    logStep(
      `Active wallets: ${wallets.map((wallet) => wallet.name).join(", ")}`
    );
  }

  if (options.skipFunding) {
    logStep("Skipping wallet funding and reusing current external balances");
    await ensureWalletTokenAccounts(
      provider,
      deployer,
      wallets,
      options.tokenMint
    );
  } else {
    await fundDemoWallets(
      provider,
      deployer,
      wallets,
      options.tokenMint,
      readiness.decimals,
      options.solPerWallet,
      options.tokensPerWallet
    );
  }
  await ensureParticipants(
    program,
    readiness.feeRecipient,
    wallets,
    options.skipParticipantInit
  );
  await ensureDeposits(
    program,
    wallets,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    readiness.vaultTokenAccount,
    options.depositPlan,
    options.skipDeposits
  );
  const multilateralTargets = determineMultilateralSearchTargets(
    clearingCapacitySummary,
    wallets.length
  );

  const singleScenario = await runSingleCommitmentScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets[0],
    wallets[1],
    options.singleCommitmentCount,
    options.singleCommitmentAmount,
    options.singleCommitmentLogEvery
  );
  const batchScenario = await runBatchCommitmentScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets.slice(1),
    wallets[0],
    options.batchCommitmentBatchCount,
    options.batchCommitmentBatchSize,
    options.batchCommitmentAmount,
    options.batchCommitmentLogEvery
  );
  const unilateralScenario = await runUnilateralClearingScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets[0],
    wallets[3],
    wallets[4],
    options.unilateralPayeeACommitmentCount,
    options.unilateralPayeeBCommitmentCount,
    options.unilateralAmountPerCommitment,
    options.unilateralLockAmount
  );
  const bilateralScenario = await runBilateralClearingScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets[1],
    wallets[2],
    options.bilateralForwardCommitmentCount,
    options.bilateralReverseCommitmentCount,
    options.bilateralAmountPerCommitment
  );
  const multilateralScenario = await runLargestExecutableMultilateralScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets,
    multilateralTargets,
    options.multilateralEdgeCommitmentCount,
    options.multilateralAmountPerCommitment
  );
  const benchmarkScenarios = [
    singleScenario.benchmark,
    batchScenario.benchmark,
    unilateralScenario.benchmark,
    bilateralScenario.benchmark,
    multilateralScenario.benchmark,
  ];
  const scenarioSignatures: ScenarioSignatureMap = {
    singleCommitment: singleScenario.primarySignature,
    batchCommitment: batchScenario.primarySignature,
    unilateralClearing: unilateralScenario.primarySignature,
    bilateralClearing: bilateralScenario.primarySignature,
    multilateralClearing: multilateralScenario.primarySignature,
  };

  logClearingRoundCapacityAnalysis(
    program.programId,
    clearingCapacitySummary,
    multilateralScenario.benchmark.requestedShape ?? multilateralTargets.overall,
    multilateralScenario.benchmark.achievedShape ?? {
      participantCount: multilateralScenario.benchmark.participantCount,
      channelCount: multilateralScenario.settledChannelCount,
    }
  );

  await logFinalSummary(
    provider,
    program,
    wallets,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals
  );

  const manifestPath = path.join(
    repoRoot,
    "config",
    `agon-protocol-demo-${runId}.json`
  );
  await saveRunManifest(manifestPath, {
    runId,
    network,
    rpcEndpoint: provider.connection.rpcEndpoint,
    programId: program.programId.toString(),
    deployer: deployer.publicKey.toString(),
    token: {
      id: options.tokenId,
      symbol: options.tokenSymbol,
      mint: options.tokenMint.toString(),
      decimals: readiness.decimals,
      vaultTokenAccount: readiness.vaultTokenAccount.toString(),
    },
    feeRecipient: readiness.feeRecipient.toString(),
    messageDomain: readiness.messageDomain.toString("hex"),
    reusedFromManifest: options.reuseManifestPath,
    settings: {
      skipFunding: options.skipFunding,
      skipParticipantInit: options.skipParticipantInit,
      skipDeposits: options.skipDeposits,
      singleCommitmentCount: options.singleCommitmentCount,
      singleCommitmentAmount: options.singleCommitmentAmount,
      batchCommitmentBatchCount: options.batchCommitmentBatchCount,
      batchCommitmentBatchSize: options.batchCommitmentBatchSize,
      batchCommitmentAmount: options.batchCommitmentAmount,
      unilateralPayeeACommitmentCount: options.unilateralPayeeACommitmentCount,
      unilateralPayeeBCommitmentCount: options.unilateralPayeeBCommitmentCount,
      unilateralAmountPerCommitment: options.unilateralAmountPerCommitment,
      unilateralLockAmount: options.unilateralLockAmount,
      bilateralForwardCommitmentCount: options.bilateralForwardCommitmentCount,
      bilateralReverseCommitmentCount: options.bilateralReverseCommitmentCount,
      bilateralAmountPerCommitment: options.bilateralAmountPerCommitment,
      multilateralEdgeCommitmentCount: options.multilateralEdgeCommitmentCount,
      multilateralAmountPerCommitment: options.multilateralAmountPerCommitment,
    },
    wallets: wallets.map((wallet) => ({
      name: wallet.name,
      publicKey: wallet.keypair.publicKey.toString(),
      participantId: wallet.participantId,
      participantPda: wallet.participantPda.toString(),
      tokenAccount: wallet.tokenAccount.toString(),
      secretPath: wallet.secretPath,
    })),
    benchmarkScenarios,
    scenarios: scenarioSignatures,
    explorer: Object.fromEntries(
      Object.entries(scenarioSignatures).map(([name, signature]) => [
        name,
        explorerUrl(signature),
      ])
    ),
    generatedAt: new Date().toISOString(),
  });
  await saveRunManifest(
    path.join(repoRoot, "config", "agon-protocol-demo-last-run.json"),
    {
      runId,
      network,
      rpcEndpoint: provider.connection.rpcEndpoint,
      programId: program.programId.toString(),
      deployer: deployer.publicKey.toString(),
      token: {
        id: options.tokenId,
        symbol: options.tokenSymbol,
        mint: options.tokenMint.toString(),
        decimals: readiness.decimals,
        vaultTokenAccount: readiness.vaultTokenAccount.toString(),
      },
      feeRecipient: readiness.feeRecipient.toString(),
      messageDomain: readiness.messageDomain.toString("hex"),
      reusedFromManifest: options.reuseManifestPath,
      settings: {
        skipFunding: options.skipFunding,
        skipParticipantInit: options.skipParticipantInit,
        skipDeposits: options.skipDeposits,
        singleCommitmentCount: options.singleCommitmentCount,
        singleCommitmentAmount: options.singleCommitmentAmount,
        batchCommitmentBatchCount: options.batchCommitmentBatchCount,
        batchCommitmentBatchSize: options.batchCommitmentBatchSize,
        batchCommitmentAmount: options.batchCommitmentAmount,
        unilateralPayeeACommitmentCount:
          options.unilateralPayeeACommitmentCount,
        unilateralPayeeBCommitmentCount:
          options.unilateralPayeeBCommitmentCount,
        unilateralAmountPerCommitment: options.unilateralAmountPerCommitment,
        unilateralLockAmount: options.unilateralLockAmount,
        bilateralForwardCommitmentCount:
          options.bilateralForwardCommitmentCount,
        bilateralReverseCommitmentCount:
          options.bilateralReverseCommitmentCount,
        bilateralAmountPerCommitment: options.bilateralAmountPerCommitment,
        multilateralEdgeCommitmentCount:
          options.multilateralEdgeCommitmentCount,
        multilateralAmountPerCommitment:
          options.multilateralAmountPerCommitment,
      },
      wallets: wallets.map((wallet) => ({
        name: wallet.name,
        publicKey: wallet.keypair.publicKey.toString(),
        participantId: wallet.participantId,
        participantPda: wallet.participantPda.toString(),
        tokenAccount: wallet.tokenAccount.toString(),
        secretPath: wallet.secretPath,
      })),
      benchmarkScenarios,
      scenarios: scenarioSignatures,
      explorer: Object.fromEntries(
        Object.entries(scenarioSignatures).map(([name, signature]) => [
          name,
          explorerUrl(signature),
        ])
      ),
      generatedAt: new Date().toISOString(),
    }
  );

  logSection("Artifacts");
  logStep(`Wallet directory: ${walletDir}`);
  logStep(`Run manifest: ${manifestPath}`);
  logStep(
    `Last-run manifest: ${path.join(
      repoRoot,
      "config",
      "agon-protocol-demo-last-run.json"
    )}`
  );
}

main().catch((error) => {
  console.error("");
  console.error("[demo] Agon Protocol demo failed");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
