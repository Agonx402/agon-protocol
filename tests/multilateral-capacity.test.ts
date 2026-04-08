import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  TEST_CHAIN_ID,
  createClearingRoundMessage,
  createMultiSigEd25519Instruction,
  ensureChannel,
  findParticipantPda,
  findTokenRegistryPda,
  program,
  provider,
  sleep,
  user1,
  user2,
  user3,
  user4,
} from "./shared/setup";

function findGlobalConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
}

function buildOrderedPairs<T>(participants: T[]): Array<[T, T]> {
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

async function sendLegacyTransaction(
  feePayer: anchor.web3.Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(feePayer);
  const signature = await provider.connection.sendRawTransaction(
    transaction.serialize(),
    { preflightCommitment: "confirmed" }
  );
  await provider.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

async function createLookupTableForAddresses(
  authority: anchor.web3.Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const recentSlot = Math.max(0, (await provider.connection.getSlot("finalized")) - 5);
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot,
    });
  await sendLegacyTransaction(authority, [createIx]);

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    lookupTable: lookupTableAddress,
    addresses,
  });
  await sendLegacyTransaction(authority, [extendIx]);

  const lastExtendObservedSlot = await provider.connection.getSlot("confirmed");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await provider.connection.getSlot("confirmed")) > lastExtendObservedSlot) {
      break;
    }
    await sleep(250);
  }

  const lookupTable = (
    await provider.connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    })
  ).value;
  if (!lookupTable) {
    throw new Error("Lookup table was created but could not be fetched");
  }
  return lookupTable;
}

async function sendVersionedTransaction(params: {
  feePayer: anchor.web3.Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
}): Promise<{ signature: string; serializedBytes: number }> {
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: params.feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.feePayer]);
  const serialized = transaction.serialize();
  const signature = await provider.connection.sendRawTransaction(serialized, {
    preflightCommitment: "confirmed",
  });
  await provider.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return { signature, serializedBytes: serialized.length };
}

describe("Multilateral capacity", () => {
  it("settles the largest current v0 + ALT multilateral round", async function () {
    this.timeout(120_000);

    const participants = [user1, user2, user3, user4];
    const participantPdas = participants.map((participant) =>
      findParticipantPda(participant.publicKey)
    );
    const participantsBefore = await Promise.all(
      participantPdas.map((participantPda) =>
        program.account.participantAccount.fetch(participantPda)
      )
    );

    const orderedPairs = buildOrderedPairs(participants);
    expect(orderedPairs).to.have.length(12);
    const allChannels = await Promise.all(
      orderedPairs.map(async ([payer, payee]) => ({
        payer,
        payee,
        ...(await ensureChannel(payer, payee.publicKey, 1)),
      }))
    );

    const increment = new anchor.BN(1_000_000);
    const candidateChannelCounts = Array.from({ length: 12 }, (_, index) => 12 - index);
    let successfulChannelCount: number | null = null;

    for (const channelCount of candidateChannelCounts) {
      const selectedChannels = allChannels.slice(0, channelCount);
      const blocks = participants.map((participant, index) => ({
        participantId: participantsBefore[index].participantId,
        entries: selectedChannels
          .filter(
            (channel) =>
              channel.payerParticipant.participantId ===
              participantsBefore[index].participantId
          )
          .map((channel) => ({
            payeeRef: participantsBefore.findIndex(
              (participant) => participant.participantId === channel.channel.payeeId
            ),
            targetCumulative: channel.channel.settledCumulative.add(increment),
          })),
      }));

      const message = createClearingRoundMessage({
        tokenId: 1,
        blocks,
      });
      const ed25519Ix = createMultiSigEd25519Instruction(participants, message);

      const remainingAccounts = [
        ...participantPdas.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
        ...blocks.flatMap((block) =>
          block.entries.map((entry) => {
            const channel = selectedChannels.find(
              (candidate) =>
                candidate.payerParticipant.participantId === block.participantId &&
                candidate.channel.payeeId ===
                  participantsBefore[entry.payeeRef].participantId
            );
            if (!channel) {
              throw new Error("Unable to resolve clearing-round channel");
            }
            return {
              pubkey: channel.channelPda,
              isSigner: false,
              isWritable: true,
            };
          })
        ),
      ];

      const clearingIx = await program.methods
        .settleClearingRound()
        .accounts({
          tokenRegistry: findTokenRegistryPda(),
          globalConfig: findGlobalConfigPda(),
          submitter: user1.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .remainingAccounts(remainingAccounts)
        .instruction();

      const lookupTable = await createLookupTableForAddresses(user1, [
        findTokenRegistryPda(),
        findGlobalConfigPda(),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...participantPdas,
        ...selectedChannels.map((channel) => channel.channelPda),
      ]);

      try {
        const { serializedBytes } = await sendVersionedTransaction({
          feePayer: user1,
          instructions: [ed25519Ix, clearingIx],
          lookupTables: [lookupTable],
        });
        expect(serializedBytes).to.be.at.most(1232);
        successfulChannelCount = channelCount;

        const channelsAfter = await Promise.all(
          selectedChannels.map((channel) =>
            program.account.channelState.fetch(channel.channelPda)
          )
        );

        selectedChannels.forEach((channel, index) => {
          expect(channelsAfter[index].settledCumulative.toString()).to.equal(
            channel.channel.settledCumulative.add(increment).toString()
          );
        });

        break;
      } catch (error) {
        if (channelCount === candidateChannelCounts[candidateChannelCounts.length - 1]) {
          throw error;
        }
      }
    }

    expect(successfulChannelCount).to.equal(6);
  });
});
