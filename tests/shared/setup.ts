import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
} from "@solana/web3.js";
import { createHash } from "crypto";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { AgonProtocol } from "../../target/types/agon_protocol";
import { expect } from "chai";
import { ed25519 } from "@noble/curves/ed25519";

// Configure the client to use the local cluster.
anchor.setProvider(anchor.AnchorProvider.env());
export const provider = anchor.AnchorProvider.env();
export const program = anchor.workspace.agonProtocol as Program<AgonProtocol>;

// Test accounts - shared across all test files
export let primaryMint: PublicKey;
export let deployer: Keypair;
export let feeRecipient: Keypair;
export let feeRecipientTokenAccount: PublicKey; // token_id=1 fee account used by shared tests
export let user1: Keypair;
export let user2: Keypair;
export let user3: Keypair;
export let user4: Keypair;
export let primaryUserTokenAccount: PublicKey;
export let user1TokenAccount: PublicKey;
export let upgradeAuthority: Keypair;
export const PRIMARY_TOKEN_ID = 1;
export const TEST_CHAIN_ID = 3;
export const INBOUND_CHANNEL_POLICY = {
  Permissionless: 0,
  ConsentRequired: 1,
  Disabled: 2,
} as const;
type RegisteredTokenInfo = {
  mint: PublicKey;
  feeRecipientTokenAccount: PublicKey;
};
const registeredTokens = new Map<number, RegisteredTokenInfo>();
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const MESSAGE_DOMAIN_TAG = Buffer.from("agon-message-domain-v1", "utf8");
const knownSigners = new Map<string, Keypair>();

export function deriveMessageDomain(
  programId: PublicKey,
  chainId: number
): Buffer {
  return createHash("sha256")
    .update(MESSAGE_DOMAIN_TAG)
    .update(programId.toBuffer())
    .update(Buffer.from([chainId & 0xff, (chainId >> 8) & 0xff]))
    .digest()
    .subarray(0, 16);
}

export const TEST_MESSAGE_DOMAIN = deriveMessageDomain(
  program.programId,
  TEST_CHAIN_ID
);

function rememberKnownSigner(signer: Keypair) {
  knownSigners.set(signer.publicKey.toString(), signer);
}

function lookupKnownSigner(owner: PublicKey): Keypair | null {
  return knownSigners.get(owner.toString()) ?? null;
}

// Setup shared test accounts and tokens
before(async () => {
  // Create test accounts — deployer pays for protocol setup; users pay for their own registration
  upgradeAuthority = (provider.wallet as any).payer as Keypair;
  deployer = anchor.web3.Keypair.generate();
  feeRecipient = anchor.web3.Keypair.generate();
  user1 = anchor.web3.Keypair.generate();
  user2 = anchor.web3.Keypair.generate();
  user3 = anchor.web3.Keypair.generate();
  user4 = anchor.web3.Keypair.generate();
  [
    upgradeAuthority,
    deployer,
    feeRecipient,
    user1,
    user2,
    user3,
    user4,
  ].forEach(rememberKnownSigner);

  // Airdrop SOL to test accounts (localnet has unlimited airdrops)
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      deployer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      feeRecipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user1.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user2.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user3.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user4.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );

  // Create the primary allowlisted test mint.
  primaryMint = await createMint(
    provider.connection,
    deployer,
    deployer.publicKey,
    null,
    6,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  // Create the fee recipient's token account for token_id=1.
  feeRecipientTokenAccount = await createAccount(
    provider.connection,
    deployer,
    primaryMint,
    feeRecipient.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  // Create a primary token account for user1 and mint funds into it.
  primaryUserTokenAccount = await createAccount(
    provider.connection,
    user1,
    primaryMint,
    user1.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  user1TokenAccount = primaryUserTokenAccount;

  await mintTo(
    provider.connection,
    deployer,
    primaryMint,
    primaryUserTokenAccount,
    deployer,
    1000000000
  );

  // Initialize the protocol
  const globalConfigPda = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );

  await program.methods
    .initialize(
      TEST_CHAIN_ID,
      30,
      new anchor.BN(0),
      deployer.publicKey
    ) // 0.3% fee, no registration fee
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      upgradeAuthority: upgradeAuthority.publicKey,
      program: program.programId,
      programData: programDataPda,
    } as any)
    .rpc();

  await program.methods
    .acceptConfigAuthority()
    .accounts({
      globalConfig: globalConfigPda,
      pendingAuthority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  // Initialize token registry after config bootstrap so its authority cannot be front-run.
  await program.methods
    .initializeTokenRegistry()
    .accounts({
      globalConfig: globalConfigPda,
      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  // Register the primary test token.
  const primaryTokenSymbol = Buffer.from("TOK1\x00\x00\x00\x00");
  const [primaryVaultTokenAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault-token-account"),
      new anchor.BN(PRIMARY_TOKEN_ID).toArrayLike(Buffer, "le", 2),
    ],
    program.programId
  );

  await program.methods
    .registerToken(PRIMARY_TOKEN_ID, [...primaryTokenSymbol])
    .accounts({
      mint: primaryMint,

      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  registeredTokens.set(PRIMARY_TOKEN_ID, {
    mint: primaryMint,
    feeRecipientTokenAccount,
  });

  const [user2ParticipantPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("participant"), user2.publicKey.toBytes()],
    program.programId
  );

  const [user3ParticipantPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("participant"), user3.publicKey.toBytes()],
    program.programId
  );

  const [user4ParticipantPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("participant"), user4.publicKey.toBytes()],
    program.programId
  );

  await program.methods
    .initializeParticipant()
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      owner: user1.publicKey,
    } as any)
    .signers([user1])
    .rpc();

  await program.methods
    .initializeParticipant()
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      owner: user2.publicKey,
    } as any)
    .signers([user2])
    .rpc();

  await program.methods
    .initializeParticipant()
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      owner: user3.publicKey,
    } as any)
    .signers([user3])
    .rpc();

  await program.methods
    .initializeParticipant()
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      owner: user4.publicKey,
    } as any)
    .signers([user4])
    .rpc();
});

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findParticipantPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("participant"), owner.toBytes()],
    program.programId
  )[0];
}

export function findTokenRegistryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token-registry")],
    program.programId
  )[0];
}

export function findVaultTokenAccountPda(
  tokenId: number = PRIMARY_TOKEN_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault-token-account"),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    program.programId
  )[0];
}

export function sha256Bytes(data: Buffer | Uint8Array): number[] {
  return [...createHash("sha256").update(data).digest()];
}

export function findChannelPda(
  payerId: number,
  payeeId: number,
  tokenId: number = PRIMARY_TOKEN_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("channel-v2"),
      new Uint8Array(new Uint32Array([payerId]).buffer),
      new Uint8Array(new Uint32Array([payeeId]).buffer),
      new Uint8Array(new Uint16Array([tokenId]).buffer),
    ],
    program.programId
  )[0];
}

export async function fetchParticipant(owner: PublicKey) {
  return program.account.participantAccount.fetch(findParticipantPda(owner));
}

export async function createTestParticipant() {
  const wallet = anchor.web3.Keypair.generate();
  rememberKnownSigner(wallet);
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );

  await program.methods
    .initializeParticipant()
    .accounts({
      owner: wallet.publicKey,
      feeRecipient: feeRecipient.publicKey,
    } as any)
    .signers([wallet])
    .rpc();

  const participantPda = findParticipantPda(wallet.publicKey);
  const participant = await program.account.participantAccount.fetch(
    participantPda
  );

  return { wallet, participantPda, participant };
}

export function getRegisteredToken(tokenId: number): RegisteredTokenInfo {
  const token = registeredTokens.get(tokenId);
  if (!token) {
    throw new Error(`Token ${tokenId} is not registered in test setup`);
  }
  return token;
}

export function getFeeRecipientTokenAccount(tokenId: number): PublicKey {
  return getRegisteredToken(tokenId).feeRecipientTokenAccount;
}

export async function registerTestToken(
  tokenId: number,
  symbol: string,
  decimals: number = 6
): Promise<RegisteredTokenInfo> {
  const existing = registeredTokens.get(tokenId);
  if (existing) {
    return existing;
  }

  const symbolBytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(symbolBytes, 0, 0, 8);

  const mint = await createMint(
    provider.connection,
    deployer,
    deployer.publicKey,
    null,
    decimals,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  const feeAccount = await createAccount(
    provider.connection,
    deployer,
    mint,
    feeRecipient.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  await program.methods
    .registerToken(tokenId, [...symbolBytes])
    .accounts({
      mint,
      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  const token = {
    mint,
    feeRecipientTokenAccount: feeAccount,
  };
  registeredTokens.set(tokenId, token);
  return token;
}

export async function createFundedTokenAccount(
  owner: Keypair,
  mint: PublicKey,
  amount: number
): Promise<PublicKey> {
  const tokenAccount = await createAccount(
    provider.connection,
    deployer,
    mint,
    owner.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  if (amount > 0) {
    await mintTo(
      provider.connection,
      deployer,
      mint,
      tokenAccount,
      deployer,
      amount
    );
  }

  return tokenAccount;
}

export async function ensureChannel(
  payer: Keypair,
  payeeOwner: PublicKey,
  tokenId: number = PRIMARY_TOKEN_ID,
  options?: {
    authorizedSigner?: PublicKey | null;
    payeeOwnerSigner?: Keypair | null;
    skipAutoPayeeOwnerSigner?: boolean;
  }
) {
  const payerParticipantPda = findParticipantPda(payer.publicKey);
  const payeeParticipantPda = findParticipantPda(payeeOwner);
  const payerParticipant = await program.account.participantAccount.fetch(
    payerParticipantPda
  );
  const payeeParticipant = await program.account.participantAccount.fetch(
    payeeParticipantPda
  );
  const channelPda = findChannelPda(
    payerParticipant.participantId,
    payeeParticipant.participantId,
    tokenId
  );

  try {
    await program.account.channelState.fetch(channelPda);
  } catch {
    const payeeOwnerSigner =
      options?.payeeOwnerSigner ??
      (options?.skipAutoPayeeOwnerSigner ? null : lookupKnownSigner(payeeOwner));
    await program.methods
      .createChannel(tokenId, options?.authorizedSigner ?? null)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        owner: payer.publicKey,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        payeeOwner: payeeOwnerSigner?.publicKey ?? null,
        channelState: channelPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers(payeeOwnerSigner ? [payer, payeeOwnerSigner] : [payer])
      .rpc();
  }

  const channel = await program.account.channelState.fetch(channelPda);

  return {
    channel,
    channelPda,
    payerParticipant,
    payerParticipantPda,
    payeeParticipant,
    payeeParticipantPda,
  };
}

/** Assert that a program call fails with an error containing the given substring.
 *  Uses both message and logs to catch program errors. Prefer specific substrings
 *  (e.g. "InvalidAuthority") over generic ones (e.g. "Invalid") to avoid false positives. */
export async function expectProgramError(
  fn: () => Promise<unknown>,
  errorSubstring: string
): Promise<void> {
  try {
    await fn();
    expect.fail(
      `Expected error containing "${errorSubstring}" but call succeeded`
    );
  } catch (e: any) {
    const msg = e.message ?? e.toString();
    const logs = e.logs?.join(" ") ?? "";
    const combined = msg + " " + logs;
    expect(
      combined,
      `Expected "${errorSubstring}" in error, got: ${msg}`
    ).to.include(errorSubstring);
  }
}

export async function parseProgramEvents(signature: string) {
  let transaction: Awaited<
    ReturnType<typeof provider.connection.getTransaction>
  > | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (transaction?.meta?.logMessages) {
      break;
    }

    await sleep(200);
  }

  expect(transaction?.meta?.logMessages, "Transaction logs not available").to
    .exist;

  const logs = transaction!.meta!.logMessages!;
  const parser = new anchor.EventParser(program.programId, program.coder);
  const parsed = [...parser.parseLogs(logs)];

  if (parsed.length > 0) {
    return parsed;
  }

  return logs
    .map((log) => program.coder.events.decode(log))
    .filter((event): event is NonNullable<typeof event> => event !== null);
}

/** Create Ed25519 instruction with multiple signers on the same message (for cooperative clearing rounds) */
export function createMultiSigEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const numSigs = signers.length;
  const headerSize = 2 + 14 * numSigs; // numSignatures(1) + padding(1) + 14 bytes per sig
  const sigBlockSize = 32 + 64; // pubkey + signature per signer
  const dataStart = headerSize;
  const messageOffset = dataStart + numSigs * sigBlockSize;

  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = numSigs;
  data[1] = 0;

  for (let i = 0; i < numSigs; i++) {
    const pubkey = signers[i].publicKey.toBytes();
    const sig = ed25519.sign(message, signers[i].secretKey.slice(0, 32));
    const sigOffset = dataStart + i * sigBlockSize + 32;
    const pubkeyOffset = dataStart + i * sigBlockSize;

    data.writeUInt16LE(sigOffset, 2 + i * 14);
    data.writeUInt16LE(0xffff, 4 + i * 14); // signature_instruction_index
    data.writeUInt16LE(pubkeyOffset, 6 + i * 14);
    data.writeUInt16LE(0xffff, 8 + i * 14); // public_key_instruction_index
    data.writeUInt16LE(messageOffset, 10 + i * 14);
    data.writeUInt16LE(message.length, 12 + i * 14);
    data.writeUInt16LE(0xffff, 14 + i * 14); // message_instruction_index

    Buffer.from(pubkey).copy(data, pubkeyOffset);
    Buffer.from(sig).copy(data, sigOffset);
  }
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

/** Create a single Ed25519 instruction that bundles many signer/message pairs. */
export function createMultiMessageEd25519Instruction(
  entries: { signer: Keypair; message: Buffer }[]
): TransactionInstruction {
  const numSigs = entries.length;
  const headerSize = 2 + 14 * numSigs;
  let cursor = headerSize;
  const buffers: Buffer[] = [];
  const offsetRows: Array<{
    signatureOffset: number;
    publicKeyOffset: number;
    messageOffset: number;
    messageLength: number;
  }> = [];

  for (const entry of entries) {
    const publicKeyOffset = cursor;
    const signatureOffset = publicKeyOffset + 32;
    const messageOffset = signatureOffset + 64;
    const signature = ed25519.sign(
      entry.message,
      entry.signer.secretKey.slice(0, 32)
    );

    buffers.push(
      Buffer.from(entry.signer.publicKey.toBytes()),
      Buffer.from(signature),
      entry.message
    );
    offsetRows.push({
      signatureOffset,
      publicKeyOffset,
      messageOffset,
      messageLength: entry.message.length,
    });
    cursor = messageOffset + entry.message.length;
  }

  const data = Buffer.alloc(cursor);
  data[0] = numSigs;
  data[1] = 0;

  offsetRows.forEach((row, index) => {
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

/** Create an Ed25519 instruction that references message bytes from another instruction. */
export function createCrossInstructionMessageEd25519Instruction(
  signer: Keypair,
  message: Buffer,
  messageInstructionIndex: number
): TransactionInstruction {
  const headerSize = 16;
  const publicKeyOffset = headerSize;
  const signatureOffset = publicKeyOffset + 32;
  const data = Buffer.alloc(signatureOffset + 64);
  const signature = ed25519.sign(message, signer.secretKey.slice(0, 32));

  data[0] = 1;
  data[1] = 0;
  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(publicKeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(0, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(messageInstructionIndex, 14);

  Buffer.from(signer.publicKey.toBytes()).copy(data, publicKeyOffset);
  Buffer.from(signature).copy(data, signatureOffset);

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

/** Helper to generate cumulative payment commitment message buffer matching the Rust v4 layout. */
export function createCommitmentMessage(params: {
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount?: anchor.BN;
  amount?: anchor.BN;
  authorizedSettler?: PublicKey;
  feeAmount?: anchor.BN;
  feeRecipientId?: number;
  messageDomain?: Buffer | Uint8Array;
}): Buffer {
  const committedAmount = params.committedAmount ?? params.amount;
  expect(committedAmount, "createCommitmentMessage requires committedAmount").to
    .exist;
  const flags =
    (params.authorizedSettler ? 1 : 0) |
    (params.feeAmount && params.feeRecipientId !== undefined ? 2 : 0);
  const body: number[] = [
    ...encodeCompactU64(BigInt(params.payerId)),
    ...encodeCompactU64(BigInt(params.payeeId)),
  ];
  const bodyBufferParts = [
    Buffer.from(body),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from(encodeCompactU64(BigInt(committedAmount!.toString()))),
  ];

  if (params.authorizedSettler) {
    bodyBufferParts.push(params.authorizedSettler.toBuffer());
  }
  if (params.feeAmount && params.feeRecipientId !== undefined) {
    bodyBufferParts.push(
      Buffer.from(encodeCompactU64(BigInt(params.feeAmount.toString()))),
      Buffer.from(encodeCompactU64(BigInt(params.feeRecipientId)))
    );
  }

  return Buffer.concat([
    Buffer.from([0x01, 0x04]),
    Buffer.from(params.messageDomain ?? TEST_MESSAGE_DOMAIN),
    Buffer.from([flags]),
    ...bodyBufferParts,
  ]);
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

/** Helper to generate cooperative clearing-round message buffer matching the Rust v4 layout. */
export function createClearingRoundMessage(params: {
  tokenId: number;
  messageDomain?: Buffer | Uint8Array;
  blocks: {
    participantId: number;
    entries: {
      payeeRef: number;
      targetCumulative: anchor.BN;
    }[];
  }[];
}): Buffer {
  const dynamicParts: number[] = [];
  for (const block of params.blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);
    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(
        ...encodeCompactU64(BigInt(entry.targetCumulative.toString()))
      );
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, 0x04]),
    Buffer.from(params.messageDomain ?? TEST_MESSAGE_DOMAIN),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from([params.blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

/** Helper to extract a specific token's balance from a ParticipantAccount */
export function getTokenBalance(participantData: any, tokenId: number) {
  const balance = participantData.tokenBalances.find(
    (b: any) => b.tokenId === tokenId
  );
  if (!balance) {
    return {
      availableBalance: new anchor.BN(0),
      withdrawingBalance: new anchor.BN(0),
      withdrawalUnlockAt: new anchor.BN(0),
      withdrawalDestination: PublicKey.default,
    };
  }
  return balance;
}

export function nextCommitmentAmount(
  channelData: {
    settledCumulative?: anchor.BN | { toString(): string };
  },
  delta: anchor.BN | number
): anchor.BN {
  const deltaBn =
    delta instanceof anchor.BN ? delta : new anchor.BN(delta.toString());
  const current = channelData.settledCumulative ?? new anchor.BN(0);
  return new anchor.BN(current.toString()).add(deltaBn);
}
