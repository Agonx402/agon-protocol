import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program } from "@solana/web3.js";
import { expect } from "chai";
import {
  createClearingRoundMessage,
  createMultiSigEd25519Instruction,
  ensureChannel,
  expectProgramError,
  findParticipantPda,
  getTokenBalance,
  program,
  user1,
  user2,
  user3,
} from "./shared/setup";

describe("Clearing Rounds", () => {
  it("creates a unilateral channel with zero cumulative settlement", async () => {
    const { channel } = await ensureChannel(user1, user2.publicKey, 1);

    expect(channel.settledCumulative.toNumber()).to.equal(0);
    expect(channel.lockedBalance.toNumber()).to.equal(0);
  });

  it("consumes locked collateral before shared balance in a single-payer clearing round", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user2.publicKey, 1);
    const payerBefore = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const channelBefore = await program.account.channelState.fetch(channelPda);

    const lockAmount = 500_000;
    await program.methods
      .lockChannelFunds(1, new anchor.BN(lockAmount))
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        owner: user1.publicKey,
      } as any)
      .signers([user1])
      .rpc();

    const channelAfterLock = await program.account.channelState.fetch(
      channelPda
    );
    expect(channelAfterLock.lockedBalance.toNumber()).to.equal(lockAmount);

    const payeeBefore = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: payerBefore.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: channelBefore.settledCumulative.add(
                new anchor.BN(lockAmount)
              ),
            },
          ],
        },
        {
          participantId: payeeBefore.participantId,
          entries: [],
        },
      ],
    });

    const ed25519Ix = createMultiSigEd25519Instruction([user1, user2], message);

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: user1.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: payeeParticipantPda, isSigner: false, isWritable: true },
        { pubkey: channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([ed25519Ix])
      .signers([user1])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfter = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );
    const channelAfter = await program.account.channelState.fetch(channelPda);

    expect(channelAfter.lockedBalance.toNumber()).to.equal(0);
    expect(channelAfter.settledCumulative.toNumber()).to.equal(
      channelBefore.settledCumulative.toNumber() + lockAmount
    );
    expect(
      getTokenBalance(payeeAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payeeBefore, 1).availableBalance.toNumber()
    ).to.equal(lockAmount);
    expect(
      getTokenBalance(payerAfter, 1).availableBalance.toNumber()
    ).to.equal(getTokenBalance(payerBefore, 1).availableBalance.toNumber() - lockAmount);
  });

  it("settles one-to-many clearing using target cumulatives", async () => {
    const first = await ensureChannel(user1, user2.publicKey, 1);
    const second = await ensureChannel(user1, user3.publicKey, 1);

    const payerBefore = await program.account.participantAccount.fetch(
      first.payerParticipantPda
    );
    const payee1Before = await program.account.participantAccount.fetch(
      first.payeeParticipantPda
    );
    const payee2Before = await program.account.participantAccount.fetch(
      second.payeeParticipantPda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: payerBefore.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: first.channel.settledCumulative.add(
                new anchor.BN(1_000_000)
              ),
            },
            {
              payeeRef: 2,
              targetCumulative: second.channel.settledCumulative.add(
                new anchor.BN(500_000)
              ),
            },
          ],
        },
        {
          participantId: payee1Before.participantId,
          entries: [],
        },
        {
          participantId: payee2Before.participantId,
          entries: [],
        },
      ],
    });

    const ed25519Ix = createMultiSigEd25519Instruction(
      [user1, user2, user3],
      message
    );

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: user1.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: first.payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: first.payeeParticipantPda, isSigner: false, isWritable: true },
        { pubkey: second.payeeParticipantPda, isSigner: false, isWritable: true },
        { pubkey: first.channelPda, isSigner: false, isWritable: true },
        { pubkey: second.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([ed25519Ix])
      .signers([user1])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      first.payerParticipantPda
    );
    const payee1After = await program.account.participantAccount.fetch(
      first.payeeParticipantPda
    );
    const payee2After = await program.account.participantAccount.fetch(
      second.payeeParticipantPda
    );
    const firstAfter = await program.account.channelState.fetch(first.channelPda);
    const secondAfter = await program.account.channelState.fetch(
      second.channelPda
    );

    expect(
      getTokenBalance(payerAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payerBefore, 1).availableBalance.toNumber()
    ).to.equal(-1_500_000);
    expect(
      getTokenBalance(payee1After, 1).availableBalance.toNumber() -
        getTokenBalance(payee1Before, 1).availableBalance.toNumber()
    ).to.equal(1_000_000);
    expect(
      getTokenBalance(payee2After, 1).availableBalance.toNumber() -
        getTokenBalance(payee2Before, 1).availableBalance.toNumber()
    ).to.equal(500_000);
    expect(firstAfter.settledCumulative.toNumber()).to.equal(
      first.channel.settledCumulative.toNumber() + 1_000_000
    );
    expect(secondAfter.settledCumulative.toNumber()).to.equal(
      second.channel.settledCumulative.toNumber() + 500_000
    );
  });

  it("settles multilateral clearing by applying only residual participant balance changes", async () => {
    const aToB = await ensureChannel(user1, user2.publicKey, 1);
    const bToC = await ensureChannel(user2, user3.publicKey, 1);
    const cToA = await ensureChannel(user3, user1.publicKey, 1);

    const participant1Pda = findParticipantPda(user1.publicKey);
    const participant2Pda = findParticipantPda(user2.publicKey);
    const participant3Pda = findParticipantPda(user3.publicKey);

    const p1Before = await program.account.participantAccount.fetch(
      participant1Pda
    );
    const p2Before = await program.account.participantAccount.fetch(
      participant2Pda
    );
    const p3Before = await program.account.participantAccount.fetch(
      participant3Pda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: aToB.payerParticipant.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: aToB.channel.settledCumulative.add(
                new anchor.BN(50_000_000)
              ),
            },
          ],
        },
        {
          participantId: bToC.payerParticipant.participantId,
          entries: [
            {
              payeeRef: 2,
              targetCumulative: bToC.channel.settledCumulative.add(
                new anchor.BN(10_000_000)
              ),
            },
          ],
        },
        {
          participantId: cToA.payerParticipant.participantId,
          entries: [
            {
              payeeRef: 0,
              targetCumulative: cToA.channel.settledCumulative.add(
                new anchor.BN(10_000_000)
              ),
            },
          ],
        },
      ],
    });

    const ed25519Ix = createMultiSigEd25519Instruction(
      [user1, user2, user3],
      message
    );

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: user1.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: participant1Pda, isSigner: false, isWritable: true },
        { pubkey: participant2Pda, isSigner: false, isWritable: true },
        { pubkey: participant3Pda, isSigner: false, isWritable: true },
        { pubkey: aToB.channelPda, isSigner: false, isWritable: true },
        { pubkey: bToC.channelPda, isSigner: false, isWritable: true },
        { pubkey: cToA.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([ed25519Ix])
      .signers([user1])
      .rpc();

    const p1After = await program.account.participantAccount.fetch(
      participant1Pda
    );
    const p2After = await program.account.participantAccount.fetch(
      participant2Pda
    );
    const p3After = await program.account.participantAccount.fetch(
      participant3Pda
    );

    expect(
      getTokenBalance(p1After, 1).availableBalance.toNumber() -
        getTokenBalance(p1Before, 1).availableBalance.toNumber()
    ).to.equal(-40_000_000);
    expect(
      getTokenBalance(p2After, 1).availableBalance.toNumber() -
        getTokenBalance(p2Before, 1).availableBalance.toNumber()
    ).to.equal(40_000_000);
    expect(
      getTokenBalance(p3After, 1).availableBalance.toNumber() -
        getTokenBalance(p3Before, 1).availableBalance.toNumber()
    ).to.equal(0);
  });

  it("rejects clearing rounds when the signature count exceeds the participant count", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user2.publicKey, 1);

    const payer = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payee = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: payer.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: channel.settledCumulative.add(
                new anchor.BN(250_000)
              ),
            },
          ],
        },
        {
          participantId: payee.participantId,
          entries: [],
        },
      ],
    });

    const ed25519Ix = createMultiSigEd25519Instruction(
      [user1, user2, user3],
      message
    );

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound()
          .accounts({
            submitter: user1.publicKey,
          } as any)
          .remainingAccounts([
            { pubkey: payerParticipantPda, isSigner: false, isWritable: true },
            { pubkey: payeeParticipantPda, isSigner: false, isWritable: true },
            { pubkey: channelPda, isSigner: false, isWritable: true },
          ])
          .preInstructions([ed25519Ix])
          .signers([user1])
          .rpc(),
      "InvalidSignature"
    );
  });
});
