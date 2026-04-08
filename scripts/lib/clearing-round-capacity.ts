import {
  AddressLookupTableAccount,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { Buffer } from "buffer";

export const LEGACY_PACKET_DATA_SIZE = 1232;
const DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES = 96;
const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const SYNTHETIC_RECENT_BLOCKHASH = "11111111111111111111111111111111";
const SYNTHETIC_MESSAGE_DOMAIN = Buffer.from("agon-capacity-v4", "utf8");

export type ClearingRoundCapacityMode =
  | "current-ed25519"
  | "current-ed25519-v0-alt"
  | "hypothetical-bls"
  | "hypothetical-bls-v0-alt";

export type ClearingRoundCapacityMeasurement = {
  mode: ClearingRoundCapacityMode;
  participantCount: number;
  channelCount: number;
  messageBytes: number;
  authEnvelopeBytes: number;
  serializedTxBytes: number;
  remainingBytes: number;
  fits: boolean;
};

export type ClearingRoundCapacitySummary = {
  currentCycle: ClearingRoundCapacityMeasurement;
  currentOverall: ClearingRoundCapacityMeasurement;
  currentV0AltCycle: ClearingRoundCapacityMeasurement;
  currentV0AltOverall: ClearingRoundCapacityMeasurement;
  blsCycle: ClearingRoundCapacityMeasurement;
  blsOverall: ClearingRoundCapacityMeasurement;
  blsV0AltCycle: ClearingRoundCapacityMeasurement;
  blsV0AltOverall: ClearingRoundCapacityMeasurement;
};

type SyntheticBlock = {
  signer: Keypair;
  participantId: number;
  entries: {
    payeeRef: number;
    channelAccount: PublicKey;
  }[];
};

function deriveProgramAddress(programId: PublicKey, seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
}

function uniquePublicKey(seed: number): PublicKey {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed >>> 0, 0);
  bytes.writeUInt32LE((seed ^ 0xa5a5_5a5a) >>> 0, 4);
  return new PublicKey(bytes);
}

function buildOrderedPairs(participantCount: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let offset = 1; offset < participantCount; offset += 1) {
    for (let payerIndex = 0; payerIndex < participantCount; payerIndex += 1) {
      pairs.push([payerIndex, (payerIndex + offset) % participantCount]);
    }
  }
  return pairs;
}

function buildSyntheticRound(
  participantCount: number,
  channelCount: number
): {
  submitter: Keypair;
  participantAccounts: PublicKey[];
  channelAccounts: PublicKey[];
  blocks: SyntheticBlock[];
} {
  if (participantCount < 3) {
    throw new Error("Multilateral clearing requires at least 3 participants");
  }
  if (channelCount < participantCount) {
    throw new Error(
      `Meaningful multilateral rounds need at least one channel per participant (channels=${channelCount}, participants=${participantCount})`
    );
  }
  if (channelCount > participantCount * (participantCount - 1)) {
    throw new Error(
      `Requested ${channelCount} directed channels, but only ${
        participantCount * (participantCount - 1)
      } unique participant pairs exist`
    );
  }

  const submitter = Keypair.generate();
  const participantAccounts = Array.from(
    { length: participantCount },
    (_, index) => uniquePublicKey(1_000 + index)
  );
  const blocks: SyntheticBlock[] = Array.from(
    { length: participantCount },
    (_, index) => ({
      signer: Keypair.generate(),
      participantId: index + 1,
      entries: [],
    })
  );

  const orderedPairs = buildOrderedPairs(participantCount);
  const channelAccounts: PublicKey[] = [];
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const [payerIndex, payeeIndex] = orderedPairs[channelIndex];
    const channelAccount = uniquePublicKey(5_000 + channelIndex);
    channelAccounts.push(channelAccount);
    blocks[payerIndex].entries.push({
      payeeRef: payeeIndex,
      channelAccount,
    });
  }

  return {
    submitter,
    participantAccounts,
    channelAccounts,
    blocks,
  };
}

function encodeCompactU64(value: bigint): number[] {
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

function createClearingRoundMessage(blocks: SyntheticBlock[]): Buffer {
  const dynamicParts: number[] = [];
  for (const block of blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);

    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(
        ...encodeCompactU64(BigInt(1_000_000 + dynamicParts.length))
      );
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, 0x04]),
    SYNTHETIC_MESSAGE_DOMAIN,
    Buffer.from([0x01, 0x00]),
    Buffer.from([blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

function createClearingRoundInstruction(
  programId: PublicKey,
  submitter: PublicKey,
  participantAccounts: PublicKey[],
  channelAccounts: PublicKey[],
  dataLength: number
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: submitter,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      ...participantAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
      ...channelAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: Buffer.alloc(dataLength),
  });
}

function estimateLegacySignedTransactionSize(params: {
  payerKey: PublicKey;
  instructions: TransactionInstruction[];
  requiredSignatures: number;
}): number {
  try {
    const message = new TransactionMessage({
      payerKey: params.payerKey,
      instructions: params.instructions,
      recentBlockhash: SYNTHETIC_RECENT_BLOCKHASH,
    }).compileToLegacyMessage();

    return (
      shortvecLength(params.requiredSignatures) +
      64 * params.requiredSignatures +
      message.serialize().length
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function buildSyntheticLookupTable(
  programId: PublicKey,
  participantAccounts: PublicKey[],
  channelAccounts: PublicKey[]
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: uniquePublicKey(9_000),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [
        deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...participantAccounts,
        ...channelAccounts,
      ],
    },
  });
}

function estimateV0AltSignedTransactionSize(params: {
  payer: Keypair;
  instructions: TransactionInstruction[];
  lookupTable: AddressLookupTableAccount;
}): number {
  try {
    const message = new TransactionMessage({
      payerKey: params.payer.publicKey,
      instructions: params.instructions,
      recentBlockhash: SYNTHETIC_RECENT_BLOCKHASH,
    }).compileToV0Message([params.lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([params.payer]);
    return transaction.serialize().length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function createCurrentEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const headerSize = 2 + 14 * signers.length;
  const signerBlockSize = 32 + 64;
  const messageOffset = headerSize + signers.length * signerBlockSize;
  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = signers.length;
  data[1] = 0;

  for (let i = 0; i < signers.length; i += 1) {
    const headerOffset = 2 + i * 14;
    const publicKeyOffset = headerSize + i * signerBlockSize;
    const signatureOffset = publicKeyOffset + 32;
    const signature = ed25519.sign(message, signers[i].secretKey.slice(0, 32));

    data.writeUInt16LE(signatureOffset, headerOffset);
    data.writeUInt16LE(0xffff, headerOffset + 2);
    data.writeUInt16LE(publicKeyOffset, headerOffset + 4);
    data.writeUInt16LE(0xffff, headerOffset + 6);
    data.writeUInt16LE(messageOffset, headerOffset + 8);
    data.writeUInt16LE(message.length, headerOffset + 10);
    data.writeUInt16LE(0xffff, headerOffset + 12);

    Buffer.from(signers[i].publicKey.toBytes()).copy(data, publicKeyOffset);
    Buffer.from(signature).copy(data, signatureOffset);
  }
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function shortvecLength(value: number): number {
  let remaining = value >>> 0;
  let length = 0;
  do {
    remaining >>>= 7;
    length += 1;
  } while (remaining > 0);
  return length;
}

export function measureClearingRoundCapacity(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  participantCount: number;
  channelCount: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const packetDataSize = params.packetDataSize ?? LEGACY_PACKET_DATA_SIZE;
  const aggregateSignatureBytes =
    params.aggregateSignatureBytes ?? DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES;
  const round = buildSyntheticRound(
    params.participantCount,
    params.channelCount
  );
  const message = createClearingRoundMessage(round.blocks);

  let authEnvelopeBytes: number;
  let serializedTxBytes: number;
  const clearingIxDataLength =
    params.mode === "hypothetical-bls" ||
    params.mode === "hypothetical-bls-v0-alt"
      ? 8 + 4 + message.length + aggregateSignatureBytes
      : 8;
  const clearingInstruction = createClearingRoundInstruction(
    params.programId,
    round.submitter.publicKey,
    round.participantAccounts,
    round.channelAccounts,
    clearingIxDataLength
  );

  if (
    params.mode === "current-ed25519" ||
    params.mode === "current-ed25519-v0-alt"
  ) {
    const ed25519Ix = createCurrentEd25519Instruction(
      round.blocks.map((block) => block.signer),
      message
    );
    authEnvelopeBytes = ed25519Ix.data.length;
    const instructions = [ed25519Ix, clearingInstruction];
    serializedTxBytes =
      params.mode === "current-ed25519-v0-alt"
        ? estimateV0AltSignedTransactionSize({
            payer: round.submitter,
            instructions,
            lookupTable: buildSyntheticLookupTable(
              params.programId,
              round.participantAccounts,
              round.channelAccounts
            ),
          })
        : estimateLegacySignedTransactionSize({
            payerKey: round.submitter.publicKey,
            instructions,
            requiredSignatures: 1,
          });
  } else {
    authEnvelopeBytes = 8 + 4 + message.length + aggregateSignatureBytes;
    const instructions = [clearingInstruction];
    serializedTxBytes =
      params.mode === "hypothetical-bls-v0-alt"
        ? estimateV0AltSignedTransactionSize({
            payer: round.submitter,
            instructions,
            lookupTable: buildSyntheticLookupTable(
              params.programId,
              round.participantAccounts,
              round.channelAccounts
            ),
          })
        : estimateLegacySignedTransactionSize({
            payerKey: round.submitter.publicKey,
            instructions,
            requiredSignatures: 1,
          });
  }

  return {
    mode: params.mode,
    participantCount: params.participantCount,
    channelCount: params.channelCount,
    messageBytes: message.length,
    authEnvelopeBytes,
    serializedTxBytes,
    remainingBytes: packetDataSize - serializedTxBytes,
    fits: serializedTxBytes <= packetDataSize,
  };
}

export function findLargestCycleRound(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  maxParticipants?: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const maxParticipants = params.maxParticipants ?? 32;
  let best = measureClearingRoundCapacity({
    programId: params.programId,
    mode: params.mode,
    participantCount: 3,
    channelCount: 3,
    packetDataSize: params.packetDataSize,
    aggregateSignatureBytes: params.aggregateSignatureBytes,
  });

  for (
    let participantCount = 4;
    participantCount <= maxParticipants;
    participantCount += 1
  ) {
    const measurement = measureClearingRoundCapacity({
      programId: params.programId,
      mode: params.mode,
      participantCount,
      channelCount: participantCount,
      packetDataSize: params.packetDataSize,
      aggregateSignatureBytes: params.aggregateSignatureBytes,
    });
    if (!measurement.fits) {
      break;
    }
    best = measurement;
  }

  return best;
}

export function findLargestOverallRound(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  maxParticipants?: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const maxParticipants = params.maxParticipants ?? 32;
  let best = measureClearingRoundCapacity({
    programId: params.programId,
    mode: params.mode,
    participantCount: 3,
    channelCount: 3,
    packetDataSize: params.packetDataSize,
    aggregateSignatureBytes: params.aggregateSignatureBytes,
  });

  for (
    let participantCount = 3;
    participantCount <= maxParticipants;
    participantCount += 1
  ) {
    const maxChannelsForParticipants =
      participantCount * (participantCount - 1);
    for (
      let channelCount = participantCount;
      channelCount <= maxChannelsForParticipants;
      channelCount += 1
    ) {
      const measurement = measureClearingRoundCapacity({
        programId: params.programId,
        mode: params.mode,
        participantCount,
        channelCount,
        packetDataSize: params.packetDataSize,
        aggregateSignatureBytes: params.aggregateSignatureBytes,
      });
      if (!measurement.fits) {
        break;
      }
      if (
        measurement.channelCount > best.channelCount ||
        (measurement.channelCount === best.channelCount &&
          measurement.participantCount > best.participantCount)
      ) {
        best = measurement;
      }
    }
  }

  return best;
}

export function summarizeClearingRoundCapacity(
  programId: PublicKey,
  aggregateSignatureBytes = DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES
): ClearingRoundCapacitySummary {
  return {
    currentCycle: findLargestCycleRound({
      programId,
      mode: "current-ed25519",
    }),
    currentOverall: findLargestOverallRound({
      programId,
      mode: "current-ed25519",
    }),
    currentV0AltCycle: findLargestCycleRound({
      programId,
      mode: "current-ed25519-v0-alt",
    }),
    currentV0AltOverall: findLargestOverallRound({
      programId,
      mode: "current-ed25519-v0-alt",
    }),
    blsCycle: findLargestCycleRound({
      programId,
      mode: "hypothetical-bls",
      aggregateSignatureBytes,
    }),
    blsOverall: findLargestOverallRound({
      programId,
      mode: "hypothetical-bls",
      aggregateSignatureBytes,
    }),
    blsV0AltCycle: findLargestCycleRound({
      programId,
      mode: "hypothetical-bls-v0-alt",
      aggregateSignatureBytes,
    }),
    blsV0AltOverall: findLargestOverallRound({
      programId,
      mode: "hypothetical-bls-v0-alt",
      aggregateSignatureBytes,
    }),
  };
}
