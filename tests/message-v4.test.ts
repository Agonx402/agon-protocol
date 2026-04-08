import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import {
  createClearingRoundMessage,
  createCommitmentMessage,
  createFundedTokenAccount,
  createMultiMessageEd25519Instruction,
  createMultiSigEd25519Instruction,
  createTestParticipant,
  ensureChannel,
  expectProgramError,
  findVaultTokenAccountPda,
  getTokenBalance,
  nextCommitmentAmount,
  primaryMint,
  program,
  user1,
} from "./shared/setup";

type TestParticipant = Awaited<ReturnType<typeof createTestParticipant>>;

async function depositToVault(
  owner: Keypair,
  participantPda: PublicKey,
  ownerTokenAccount: PublicKey,
  tokenId: number,
  amount: number
): Promise<void> {
  await program.methods
    .deposit(tokenId, new anchor.BN(amount))
    .accounts({
      owner: owner.publicKey,
      participantAccount: participantPda,
      ownerTokenAccount,
      vaultTokenAccount: findVaultTokenAccountPda(tokenId),
    } as any)
    .signers([owner])
    .rpc();
}

async function createPrimaryFundedParticipant(
  amount: number
): Promise<TestParticipant & { ownerTokenAccount: PublicKey }> {
  const participant = await createTestParticipant();
  const ownerTokenAccount = await createFundedTokenAccount(
    participant.wallet,
    primaryMint,
    amount
  );
  await depositToVault(
    participant.wallet,
    participant.participantPda,
    ownerTokenAccount,
    1,
    amount
  );
  return {
    ...participant,
    ownerTokenAccount,
  };
}

describe("Message v4", () => {
  it("settles an individual v4 commitment", async () => {
    const payer = await createPrimaryFundedParticipant(5_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const message = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(channel, 1_250_000),
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message,
    });

    const payerBefore = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeBefore = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([payee.wallet])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfter = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    expect(
      getTokenBalance(payerAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payerBefore, 1).availableBalance.toNumber()
    ).to.equal(-1_250_000);
    expect(
      getTokenBalance(payeeAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payeeBefore, 1).availableBalance.toNumber()
    ).to.equal(1_250_000);
  });

  it("settles a bundle of v4 commitments for one payee", async () => {
    const payee = await createTestParticipant();
    const payers = await Promise.all([
      createPrimaryFundedParticipant(6_000_000),
      createPrimaryFundedParticipant(6_000_000),
    ]);
    const deltas = [1_000_000, 1_500_000];

    const channels = await Promise.all(
      payers.map(async (payer) => {
        const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);
        return {
          ...ensured,
          payer,
        };
      })
    );

    const bundleEntries = channels.map((channelEntry, index) => ({
      signer: channelEntry.payer.wallet,
      message: createCommitmentMessage({
        payerId: channelEntry.channel.payerId,
        payeeId: channelEntry.channel.payeeId,
        tokenId: 1,
        committedAmount: nextCommitmentAmount(channelEntry.channel, deltas[index]),
      }),
    }));

    const payeeBefore = await program.account.participantAccount.fetch(
      payee.participantPda
    );

    await program.methods
      .settleCommitmentBundle(bundleEntries.length)
      .accounts({
        payeeAccount: payee.participantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .remainingAccounts(
        channels.flatMap((channelEntry) => [
          {
            pubkey: channelEntry.payerParticipantPda,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: channelEntry.channelPda,
            isSigner: false,
            isWritable: true,
          },
        ])
      )
      .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
      .signers([payee.wallet])
      .rpc();

    const payeeAfter = await program.account.participantAccount.fetch(
      payee.participantPda
    );
    expect(
      getTokenBalance(payeeAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payeeBefore, 1).availableBalance.toNumber()
    ).to.equal(2_500_000);
  });

  it("settles a v4 multilateral clearing round", async () => {
    const a = await createPrimaryFundedParticipant(5_000_000);
    const b = await createPrimaryFundedParticipant(5_000_000);
    const c = await createPrimaryFundedParticipant(5_000_000);
    const aToB = await ensureChannel(a.wallet, b.wallet.publicKey, 1);
    const bToC = await ensureChannel(b.wallet, c.wallet.publicKey, 1);
    const cToA = await ensureChannel(c.wallet, a.wallet.publicKey, 1);

    const participantBlocks = [
      {
        participantId: aToB.payerParticipant.participantId,
        entries: [
          {
            payeeRef: 1,
            targetCumulative: nextCommitmentAmount(aToB.channel, 500_000),
          },
        ],
      },
      {
        participantId: bToC.payerParticipant.participantId,
        entries: [
          {
            payeeRef: 2,
            targetCumulative: nextCommitmentAmount(bToC.channel, 500_000),
          },
        ],
      },
      {
        participantId: cToA.payerParticipant.participantId,
        entries: [
          {
            payeeRef: 0,
            targetCumulative: nextCommitmentAmount(cToA.channel, 500_000),
          },
        ],
      },
    ];

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: participantBlocks,
    });

    const ed25519Ix = createMultiSigEd25519Instruction(
      [a.wallet, b.wallet, c.wallet],
      message
    );

    const participant1Before = await program.account.participantAccount.fetch(
      aToB.payerParticipantPda
    );
    const participant2Before = await program.account.participantAccount.fetch(
      bToC.payerParticipantPda
    );
    const participant3Before = await program.account.participantAccount.fetch(
      cToA.payerParticipantPda
    );

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: a.wallet.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: aToB.payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: bToC.payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: cToA.payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: aToB.channelPda, isSigner: false, isWritable: true },
        { pubkey: bToC.channelPda, isSigner: false, isWritable: true },
        { pubkey: cToA.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([ed25519Ix])
      .signers([a.wallet])
      .rpc();

    const participant1After = await program.account.participantAccount.fetch(
      aToB.payerParticipantPda
    );
    const participant2After = await program.account.participantAccount.fetch(
      bToC.payerParticipantPda
    );
    const participant3After = await program.account.participantAccount.fetch(
      cToA.payerParticipantPda
    );

    expect(
      getTokenBalance(participant1After, 1).availableBalance.toNumber() -
        getTokenBalance(participant1Before, 1).availableBalance.toNumber()
    ).to.equal(0);
    expect(
      getTokenBalance(participant2After, 1).availableBalance.toNumber() -
        getTokenBalance(participant2Before, 1).availableBalance.toNumber()
    ).to.equal(0);
    expect(
      getTokenBalance(participant3After, 1).availableBalance.toNumber() -
        getTokenBalance(participant3Before, 1).availableBalance.toNumber()
    ).to.equal(0);
  });

  it("rejects replaying a stale v4 commitment after the lane has already advanced", async () => {
    const payer = await createPrimaryFundedParticipant(5_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const staleMessage = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(channel, 1_000_000),
    });
    const staleSignatureIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: staleMessage,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([staleSignatureIx])
      .signers([payee.wallet])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            submitter: payee.wallet.publicKey,
          } as any)
          .preInstructions([staleSignatureIx])
          .signers([payee.wallet])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });
});
