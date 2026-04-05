import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Ed25519Program } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  deployer,
  primaryMint,
  user1,
  user2,
  user3,
  user4,
  user1TokenAccount,
  feeRecipientTokenAccount,
  expectProgramError,
  createTestParticipant,
  createFundedTokenAccount,
  createCommitmentMessage,
  ensureChannel,
  findLaneStatePda,
  findParticipantPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
} from "./shared/setup";

describe("Negative tests — expect specific errors", () => {
  it("update_config: rejects InvalidFeeBps (too low)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 2, null) // Fee BPS too low (< 3)
          .accounts({
            globalConfig: globalConfigPda,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it("update_config: rejects InvalidFeeBps (too high)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 31, null) // Fee BPS too high (> 30)
          .accounts({
            globalConfig: globalConfigPda,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it("update_config: rejects non-authority", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 20, null)
          .accounts({
            globalConfig: globalConfigPda,
            authority: user1.publicKey, // Not the authority
          } as any)
          .signers([user1])
          .rpc(),
      "ConstraintHasOne"
    );
  });

  it("deposit: rejects AmountMustBePositive (0)", async () => {
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

    await expectProgramError(
      () =>
        program.methods
          .deposit(1, new anchor.BN(0)) // token_id = 1, amount = 0
          .accounts({
            ownerTokenAccount: user1TokenAccount,
            owner: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });

  it("deposit_for: rejects length mismatch", async () => {
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

    // Try to deposit to 2 participants but only provide 1 amount
    await expectProgramError(
      () =>
        program.methods
          .depositFor(1, [new anchor.BN(10000000)]) // token_id = 1, only 1 amount
          .accounts({
            funderTokenAccount: user1TokenAccount,
            funder: user1.publicKey,
          } as any)
          .remainingAccounts([
            // Two participant accounts but only one amount
            { pubkey: user1.publicKey, isSigner: false, isWritable: true },
            { pubkey: user2.publicKey, isSigner: false, isWritable: true },
          ])
          .signers([user1])
          .rpc(),
      "InvalidDepositFor"
    );
  });

  it("request_withdrawal: rejects AmountMustBePositive (0)", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    await expectProgramError(
      () =>
        program.methods
          .requestWithdrawal(1, new anchor.BN(0), user1TokenAccount)
          .accounts({
            participantAccount: participantPda,
            owner: user1.publicKey,
            withdrawalDestination: user1TokenAccount,
          } as any)
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });
  it("request_withdrawal: rejects WithdrawalAlreadyPending", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    await program.methods
      .requestWithdrawal(1, new anchor.BN(1000000), user1TokenAccount)
      .accounts({
        participantAccount: participantPda,
        owner: user1.publicKey,
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .requestWithdrawal(1, new anchor.BN(500000), user1TokenAccount)
          .accounts({
            participantAccount: participantPda,
            owner: user1.publicKey,
            withdrawalDestination: user1TokenAccount,
          } as any)
          .signers([user1])
          .rpc(),
      "WithdrawalAlreadyPending"
    );

    await program.methods
      .cancelWithdrawal(1)
      .accounts({
        participantAccount: participantPda,
        owner: user1.publicKey,
      } as any)
      .signers([user1])
      .rpc();
  });

  it("create_channel: rejects ChannelAlreadyExists", async () => {
    const [payerParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user3.publicKey.toBytes()],
      program.programId
    );
    const [payeeParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user4.publicKey.toBytes()],
      program.programId
    );
    const [channelPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("channel-v1"),
        new Uint8Array(new Uint32Array([2]).buffer), // payer_id
        new Uint8Array(new Uint32Array([3]).buffer), // payee_id
        new Uint8Array(new Uint16Array([1]).buffer), // token_id = 1 (primary token)
      ],
      program.programId
    );
    // Try to create the same channel twice
    await program.methods
      .createChannel(1, null) // token_id = 1 (primary token)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        owner: user3.publicKey,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        laneState: findLaneStatePda(2, 3, 1),
        payeeOwner: user4.publicKey,
        channelState: channelPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user3, user4])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .createChannel(1, null) // token_id = 1 (primary token)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            owner: user3.publicKey,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            laneState: findLaneStatePda(2, 3, 1),
            payeeOwner: user4.publicKey,
            channelState: channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user3, user4])
          .rpc(),
      "Simulation failed"
    );
  });

  it("request_close_channel: rejects ChannelAlreadyClosing", async () => {
    const [payerParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user3.publicKey.toBytes()],
      program.programId
    );
    const [payeeParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user4.publicKey.toBytes()],
      program.programId
    );
    const [channelPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("channel-v1"),
        new Uint8Array(new Uint32Array([2]).buffer), // payer_id
        new Uint8Array(new Uint32Array([3]).buffer), // payee_id
        new Uint8Array(new Uint16Array([1]).buffer), // token_id = 1 (primary token)
      ],
      program.programId
    );

    // Request channel close
    await program.methods
      .requestCloseChannel(1)
      .accounts({
        channelState: channelPda,
        requester: user3.publicKey,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
      } as any)
      .signers([user3])
      .rpc();

    // Try to request close again
    await expectProgramError(
      () =>
        program.methods
          .requestCloseChannel(1)
          .accounts({
            channelState: channelPda,
            requester: user3.publicKey,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
          } as any)
          .signers([user3])
          .rpc(),
      "ChannelAlreadyClosing"
    );
  });

  it("close_participant: rejects BalanceMustBeZeroToClose", async () => {
    const participant = await createTestParticipant();
    const tokenAccount = await createFundedTokenAccount(
      participant.wallet,
      primaryMint,
      1_000_000
    );

    await program.methods
      .deposit(1, new anchor.BN(1000000)) // 1 primary-token unit
      .accounts({
        participantAccount: participant.participantPda,
        owner: participant.wallet.publicKey,
        ownerTokenAccount: tokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([participant.wallet])
      .rpc();

    // Try to close participant with non-zero balance
    await expectProgramError(
      () =>
        program.methods
          .closeParticipant()
          .accounts({
            participantAccount: participant.participantPda,
            owner: participant.wallet.publicKey,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "BalanceMustBeZeroToClose"
    );
  });

  it("request_withdrawal: rejects InvalidWithdrawalDestination (zero address)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .requestWithdrawal(1, new anchor.BN(1000000), user2.publicKey) // token_id = 1, wrong destination (not a token account)
          .accounts({
            owner: user1.publicKey,
            withdrawalDestination: user2.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "AccountOwnedByWrongProgram"
    );
  });

  it("execute_close_channel: rejects ChannelNotClosing", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    await expectProgramError(
      () =>
        program.methods
          .executeCloseChannel(1)
          .accounts({
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            channelState: channelPda,
            rentRecipient: payer.wallet.publicKey,
          } as any)
          .rpc(),
      "ChannelNotClosing"
    );
  });

  it("execute_close_channel: rejects WithdrawalLocked (before timelock)", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    await program.methods
      .requestCloseChannel(1)
      .accounts({
        payerAccount: payerParticipantPda,
        channelState: channelPda,
        requester: payer.wallet.publicKey,
        payeeAccount: payeeParticipantPda,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .executeCloseChannel(1)
          .accounts({
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            channelState: channelPda,
            rentRecipient: payer.wallet.publicKey,
          } as any)
          .rpc(),
      "WithdrawalLocked"
    );
  });

  it("execute_close_channel: rejects InvalidRentRecipient", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    await program.methods
      .requestCloseChannel(1)
      .accounts({
        payerAccount: payerParticipantPda,
        channelState: channelPda,
        requester: payer.wallet.publicKey,
        payeeAccount: payeeParticipantPda,
      } as any)
      .signers([payer.wallet])
      .rpc();

    // Wait for timelock
    await new Promise((resolve) => setTimeout(resolve, 3500));

    await expectProgramError(
      () =>
        program.methods
          .executeCloseChannel(1)
          .accounts({
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            channelState: channelPda,
            rentRecipient: payee.wallet.publicKey,
          } as any)
          .rpc(),
      "InvalidRentRecipient"
    );
  });

  it("update_config: rejects InvalidAuthority (zero address)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(PublicKey.default, null, null, null) // Zero address authority
          .accounts({
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidAuthority"
    );
  });

  it("update_config: rejects InvalidFeeRecipient (zero address)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, PublicKey.default, null, null) // Zero address fee recipient
          .accounts({
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeRecipient"
    );
  });

  it("update_config: rejects a fee recipient that is not a system wallet", async () => {
    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, feeRecipientTokenAccount, null, null)
          .accounts({
            authority: deployer.publicKey,
          } as any)
          .remainingAccounts([
            {
              pubkey: feeRecipientTokenAccount,
              isSigner: false,
              isWritable: false,
            },
          ])
          .signers([deployer])
          .rpc(),
      "InvalidFeeRecipient"
    );
  });

  it("update_config: rejects InvalidRegistrationFee (out of range)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    // Try to set registration fee that's too high (> 0.01 SOL)
    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, null, new anchor.BN(11_000_000)) // > 0.01 SOL
          .accounts({
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidRegistrationFee"
    );
  });

  it("settle_individual: rejects FeeRecipientRequired when commitment has fee", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const feeRecipient = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    // commitment message with fee: 75 bytes (commitment_MSG_SIZE_WITH_FEE + 2 for token_id)
    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: new anchor.BN(2_000_000),
      tokenId: 1,
      feeAmount: new anchor.BN(10_000),
      feeRecipientId: feeRecipient.participant.participantId,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
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
            submitter: payee.wallet.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([payee.wallet])
          .rpc(),
      "FeeRecipientRequired"
    );
  });

  it("settle_individual: rejects InvalidMessageDomain", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: new anchor.BN(2_000_000),
      tokenId: 1,
      messageDomain: Buffer.alloc(16, 9),
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
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
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "InvalidMessageDomain"
    );
  });

  it("settle_individual: rejects CommitmentAmountMustIncrease (zero amount)", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: new anchor.BN(0),
      tokenId: 1,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
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
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });
  it("settle_individual: rejects InsufficientBalance", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      laneGeneration: channel.laneGeneration,
      committedAmount: new anchor.BN(100_000_000),
      tokenId: 1,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
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
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "InsufficientBalance"
    );
  });
  it("deposit_for: rejects ParticipantNotFound (invalid remaining account)", async () => {
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

    // Try to deposit to a non-participant account
    const invalidParticipant = anchor.web3.Keypair.generate().publicKey;

    await expectProgramError(
      () =>
        program.methods
          .depositFor(1, [new anchor.BN(10000000)])
          .accounts({
            funderTokenAccount: user1TokenAccount,
            funder: user1.publicKey,
          } as any)
          .remainingAccounts([
            { pubkey: invalidParticipant, isSigner: false, isWritable: true }, // Not a valid participant PDA
          ])
          .signers([user1])
          .rpc(),
      "ParticipantNotFound"
    );
  });

  it("deposit_for: rejects AmountMustBePositive (all zeros)", async () => {
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

    const [participant1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );

    // Try to deposit zero amounts
    await expectProgramError(
      () =>
        program.methods
          .depositFor(1, [new anchor.BN(0)]) // Zero amount
          .accounts({
            funderTokenAccount: user1TokenAccount,
            funder: user1.publicKey,
          } as any)
          .remainingAccounts([
            { pubkey: participant1Pda, isSigner: false, isWritable: true },
          ])
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });

  it("lock_channel_funds: rejects AmountMustBePositive", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user2.publicKey, 1);

    await expectProgramError(
      () =>
        program.methods
          .lockChannelFunds(1, new anchor.BN(0))
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            owner: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });
  it("lock_channel_funds: rejects InsufficientBalance", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user2.publicKey, 1);

    await expectProgramError(
      () =>
        program.methods
          .lockChannelFunds(1, new anchor.BN(1000000000000))
          .accounts({
            channelState: channelPda,
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            owner: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "InsufficientBalance"
    );
  });
});
