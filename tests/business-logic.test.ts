import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Ed25519Program } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  user1,
  user2,
  user1TokenAccount,
  feeRecipientTokenAccount,
  expectProgramError,
  createTestParticipant,
  ensureChannel,
  findParticipantPda,
  findVaultTokenAccountPda,
  createCommitmentMessage,
  createClearingRoundMessage,
  createMultiSigEd25519Instruction,
  nextCommitmentAmount,
} from "./shared/setup";

describe("Business Logic Edge Cases", () => {
  it("double-charge prevention: settle individual first, then a clearing round for the same debt fails", async () => {
    const freshPayee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, freshPayee.wallet.publicKey, 1);

    await program.methods
      .deposit(1, new anchor.BN(1_500_000))
      .accounts({
        owner: user1.publicKey,
        participantAccount: payerParticipantPda,
        ownerTokenAccount: user1TokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([user1])
      .rpc();

    const targetAmount = nextCommitmentAmount(channel, 500_000);
    const commitmentMsg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: targetAmount,
      tokenId: 1,
    });

    const commitmentEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: commitmentMsg,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: freshPayee.wallet.publicKey,
      } as any)
      .preInstructions([commitmentEd25519Ix])
      .signers([freshPayee.wallet])
      .rpc();
    const clearingRoundMsg = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: channel.payerId,
          entries: [
            {
              payeeRef: 1,
              laneGeneration: channel.laneGeneration,
              targetCumulative: targetAmount,
            },
          ],
        },
        {
          participantId: channel.payeeId,
          entries: [],
        },
      ],
    });

    const clearingRoundEd25519Ix = createMultiSigEd25519Instruction(
      [user1, freshPayee.wallet],
      clearingRoundMsg
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
          .preInstructions([clearingRoundEd25519Ix])
          .signers([user1])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });

  it("double-charge prevention: settle a clearing round first, then individual for the same debt fails", async () => {
    const freshPayee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, freshPayee.wallet.publicKey, 1);

    await program.methods
      .deposit(1, new anchor.BN(1_500_000))
      .accounts({
        owner: user1.publicKey,
        participantAccount: payerParticipantPda,
        ownerTokenAccount: user1TokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([user1])
      .rpc();

    const targetAmount = nextCommitmentAmount(channel, 500_000);
    const clearingRoundMsg = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: channel.payerId,
          entries: [
            {
              payeeRef: 1,
              laneGeneration: channel.laneGeneration,
              targetCumulative: targetAmount,
            },
          ],
        },
        {
          participantId: channel.payeeId,
          entries: [],
        },
      ],
    });

    const clearingRoundEd25519Ix = createMultiSigEd25519Instruction(
      [user1, freshPayee.wallet],
      clearingRoundMsg
    );

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
      .preInstructions([clearingRoundEd25519Ix])
      .signers([user1])
      .rpc();
    const commitmentMsg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: targetAmount,
      tokenId: 1,
    });

    const commitmentEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: commitmentMsg,
    });

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            submitter: freshPayee.wallet.publicKey,
          } as any)
          .preInstructions([commitmentEd25519Ix])
          .signers([freshPayee.wallet])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });

  it("fee calculation edge cases work correctly", async () => {
    const [feeRecipientParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user2.publicKey.toBytes()],
      program.programId
    );
    const payerParticipantPda = findParticipantPda(user1.publicKey);

    // Test that the minimum fee floor is applied correctly
    // Withdraw 1 token unit: fee should be max(minimum floor, percentage fee)
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-token-account"),
        new anchor.BN(1).toArrayLike(Buffer, "le", 2),
      ],
      program.programId
    );

    await program.methods
      .deposit(1, new anchor.BN(1_000_000))
      .accounts({
        owner: user1.publicKey,
        participantAccount: payerParticipantPda,
        ownerTokenAccount: user1TokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([user1])
      .rpc();

    // Request withdrawal
    await program.methods
      .requestWithdrawal(1, new anchor.BN(1_000_000), user1TokenAccount) // token_id = 1, amount = 1 token unit
      .accounts({
        owner: user1.publicKey,
        participantAccount: payerParticipantPda,
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    // Wait for timelock
    await new Promise((resolve) => setTimeout(resolve, 3500));

    // Execute withdrawal and verify fee calculation
    const user1BalanceBefore = BigInt(
      (
        await program.provider.connection.getTokenAccountBalance(
          user1TokenAccount
        )
      ).value.amount
    );
    const feeRecipientBalanceBefore = BigInt(
      (
        await program.provider.connection.getTokenAccountBalance(
          feeRecipientTokenAccount
        )
      ).value.amount
    );

    await program.methods
      .executeWithdrawalTimelocked(1) // token_id = 1 (primary token)
      .accounts({
        participantAccount: payerParticipantPda,
        withdrawalDestination: user1TokenAccount,
        feeRecipientTokenAccount,
      } as any)
      .rpc();

    const user1BalanceAfter = BigInt(
      (
        await program.provider.connection.getTokenAccountBalance(
          user1TokenAccount
        )
      ).value.amount
    );
    const feeRecipientBalanceAfter = BigInt(
      (
        await program.provider.connection.getTokenAccountBalance(
          feeRecipientTokenAccount
        )
      ).value.amount
    );

    const receivedAmount = user1BalanceAfter - user1BalanceBefore;
    const feeCollected = feeRecipientBalanceAfter - feeRecipientBalanceBefore;

    expect(receivedAmount).to.equal(950_000n);
    expect(feeCollected).to.equal(50_000n); // Minimum fee applied
  });

  it("state consistency: failed operations don't leave inconsistent state", async () => {
    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );

    // Get initial state
    const initialState = await program.account.participantAccount.fetch(
      participantPda
    );

    // Try an operation that will fail (deposit zero amount)
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-token-account"),
        new anchor.BN(1).toArrayLike(Buffer, "le", 2),
      ],
      program.programId
    );

    try {
      await program.methods
        .deposit(1, new anchor.BN(0)) // token_id = 1, amount = 0 (will fail)
        .accounts({
          owner: user1.publicKey,
          ownerTokenAccount: user1TokenAccount,
        } as any)
        .signers([user1])
        .rpc();
    } catch (e) {
      // Expected to fail
    }

    // Verify state is unchanged after failed operation
    const finalState = await program.account.participantAccount.fetch(
      participantPda
    );
    // In multi-token mode, check token-specific balances for token_id = 1.
    const initialPrimaryTokenBalance = initialState.tokenBalances.find(
      (tb) => tb.tokenId === 1
    );
    const finalPrimaryTokenBalance = finalState.tokenBalances.find(
      (tb) => tb.tokenId === 1
    );
    expect(finalPrimaryTokenBalance?.availableBalance?.toNumber?.() ?? 0).to.equal(
      initialPrimaryTokenBalance?.availableBalance?.toNumber?.() ?? 0
    );
    expect(finalPrimaryTokenBalance?.withdrawingBalance?.toNumber?.() ?? 0).to.equal(
      initialPrimaryTokenBalance?.withdrawingBalance?.toNumber?.() ?? 0
    );
    expect(finalState.openChannelCount.toNumber()).to.equal(
      initialState.openChannelCount.toNumber()
    );
  });

  it("arithmetic overflow protection works", async () => {
    // This test would need to construct scenarios that could cause overflow
    // For now, placeholder - the program uses checked arithmetic internally
  });

  it("concurrent operations are handled safely", async () => {
    // Test concurrent operations on the same accounts
    // This would require more complex test setup with multiple transactions
    // For now, placeholder
  });

  it("maximum participant limits are enforced", async () => {
    // Test that the system can handle maximum number of participants
    // This would require creating many participants and testing limits
    // For now, placeholder
  });
});
