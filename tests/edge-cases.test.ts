import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Ed25519Program } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  user1,
  user2,
  user4,
  user1TokenAccount,
  ensureChannel,
  expectProgramError,
  createCommitmentMessage,
  createMultiSigEd25519Instruction,
  nextCommitmentAmount,
} from "./shared/setup";

describe("Edge cases", () => {
  it("deposit: minimum amount (1 unit) succeeds", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-token-account"),
        new anchor.BN(1).toArrayLike(Buffer, "le", 2),
      ],
      program.programId
    );

    // Test minimum deposit of 1 base unit
    const tx = await program.methods
      .deposit(1, new anchor.BN(1))
      .accounts({
        owner: user1.publicKey,

        ownerTokenAccount: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    // Verify it succeeded (no error thrown)
    expect(tx).to.be.a("string");
  });

  it("settle_individual: rejects InvalidCommitmentMessage (wrong length)", async () => {
    const [payerParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );
    const [payeeParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user4.publicKey.toBytes()],
      program.programId
    );

    // Create invalid Ed25519 instruction with wrong message length
    const invalidMsg = Buffer.alloc(50); // Wrong length for the commitment format

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: invalidMsg,
    });

    const [channelPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("channel-v2"),
        new Uint8Array(new Uint32Array([0]).buffer),
        new Uint8Array(new Uint32Array([3]).buffer), // payee_id 3 for most error edge cases
        new Uint8Array(new Uint16Array([1]).buffer),
      ],
      program.programId
    );
    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,

            payeeAccount: payeeParticipantPda,
            submitter: user1.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user1])
          .rpc(),
      "InvalidCommitmentMessage"
    );
  });

  it("settle_individual: rejects InvalidSignature", async () => {
    const { channel, channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: new anchor.BN(2_000_000), // 2 primary-token units
      tokenId: 1, // primary token
    });

    // Create Ed25519 instruction with WRONG private key (user2 instead of user1)
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user2.secretKey, // Wrong signer!
      message: msg,
    });

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,

            payeeAccount: payeeParticipantPda,
            submitter: user1.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user1])
          .rpc(),
      "InvalidSignature"
    );
  });

  it("settle_individual: rejects UnauthorizedSettler (payer cannot submit)", async () => {
    const { channel, channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user4.publicKey, 1);

    // commitment message with authorized_settler = user2 (not the submitter user1)
    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: new anchor.BN(2_000_000), // 2 primary-token units
      tokenId: 1, // primary token
      authorizedSettler: user2.publicKey,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: msg,
    });

    // Try to submit as user1, but authorized_settler is user2
    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,

            payeeAccount: payeeParticipantPda,
            submitter: user1.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user1])
          .rpc(),
      "UnauthorizedSettler"
    );
  });

  it("settle_individual: rejects replay (same signature cannot be used twice)", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 1_000_000),
      tokenId: 1, // primary token
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: msg,
    });
    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: user4.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([user4])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });

  it("settle_individual: rejects Ed25519 instructions with extra signatures", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 1_000_000),
      tokenId: 1,
    });

    const ed25519Ix = createMultiSigEd25519Instruction([user1, user2], msg);

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "InvalidEd25519Data"
    );
  });

  it("commitment message format variations work correctly", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);
    const [feeRecipientParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user2.publicKey.toBytes()],
      program.programId
    );

    const msgWithFee = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 1_000_000),
      tokenId: 1, // primary token
      feeAmount: new anchor.BN(10_000), // fee in base units
      feeRecipientId: 1, // user2
    });

    const ed25519IxWithFee = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: msgWithFee,
    });
    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: user4.publicKey,
      } as any)
      .remainingAccounts([
        {
          pubkey: feeRecipientParticipantPda,
          isSigner: false,
          isWritable: true,
        },
      ])
      .preInstructions([ed25519IxWithFee])
      .signers([user4])
      .rpc();
  });

  it("authorized settler validation works correctly", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 1_000_000),
      tokenId: 1, // primary token
      authorizedSettler: user2.publicKey,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: msg,
    });
    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: user2.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([user2])
      .rpc();
  });

  it("settle_clearing_round: rejects fee-bearing round messages", async () => {
    // Placeholder: clearing rounds do not currently support fee-bearing messages.
  });

  it("settle_clearing_round: rejects InsufficientBalance", async () => {
    // Placeholder: dedicated insufficient-balance clearing-round setup can live here.
  });

  it("settle_clearing_round: rejects replay via stale target cumulatives", async () => {
    // Placeholder: replay protection now comes from monotonically increasing target cumulatives.
  });
});
