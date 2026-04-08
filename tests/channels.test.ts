import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  createCommitmentMessage,
  createFundedTokenAccount,
  createTestParticipant,
  ensureChannel,
  expectProgramError,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  getTokenBalance,
  INBOUND_CHANNEL_POLICY,
  nextCommitmentAmount,
  primaryMint,
  program,
  registerTestToken,
  sleep,
} from "./shared/setup";

const SECOND_CHANNEL_TOKEN_ID = 13;

async function depositToParticipant(
  owner: anchor.web3.Keypair,
  participantPda: PublicKey,
  ownerTokenAccount: PublicKey,
  tokenId: number,
  amount: number
) {
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

describe("Permanent Channel Lifecycle", () => {
  it("stores a custom authorized signer when creating a channel", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const delegatedSigner = anchor.web3.Keypair.generate();

    const { channel } = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      {
        authorizedSigner: delegatedSigner.publicKey,
        payeeOwnerSigner: payee.wallet,
      }
    );

    expect(channel.authorizedSigner.toString()).to.equal(
      delegatedSigner.publicKey.toString()
    );
  });

  it("rejects self-channels for the same participant", async () => {
    const participant = await createTestParticipant();
    const tokenIdBytes = Buffer.alloc(2);
    tokenIdBytes.writeUInt16LE(1, 0);
    const channelPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("channel-v2"),
        new anchor.BN(participant.participant.participantId).toArrayLike(
          Buffer,
          "le",
          4
        ),
        new anchor.BN(participant.participant.participantId).toArrayLike(
          Buffer,
          "le",
          4
        ),
        tokenIdBytes,
      ],
      program.programId
    )[0];

    await expectProgramError(
      () =>
        program.methods
          .createChannel(1, null)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            owner: participant.wallet.publicKey,
            payerAccount: participant.participantPda,
            payeeAccount: participant.participantPda,
            channelState: channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "SelfChannelNotAllowed"
    );
  });

  it("rejects duplicate channel creation for the same payer, payee, and token", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      { payeeOwnerSigner: payee.wallet }
    );

    await expectProgramError(
      () =>
        program.methods
          .createChannel(1, null)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            owner: payer.wallet.publicKey,
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            payeeOwner: payee.wallet.publicKey,
            channelState: ensured.channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([payer.wallet, payee.wallet])
          .rpc(),
      "already in use"
    );
  });

  it("creates distinct permanent channels per token for the same payer and payee", async () => {
    await registerTestToken(SECOND_CHANNEL_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    const firstChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1
    );

    const secondChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_CHANNEL_TOKEN_ID
    );

    expect(firstChannel.channelPda.toString()).to.not.equal(
      secondChannel.channelPda.toString()
    );
    expect(secondChannel.channel.tokenId).to.equal(SECOND_CHANNEL_TOKEN_ID);
  });

  it("lock_channel_funds remains additive", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
        payeeOwnerSigner: payee.wallet,
      });

    await depositToParticipant(
      payer.wallet,
      payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );

    await program.methods
      .lockChannelFunds(1, new anchor.BN(200_000))
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await program.methods
      .lockChannelFunds(1, new anchor.BN(150_000))
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const channel = await program.account.channelState.fetch(channelPda);
    expect(channel.lockedBalance.toNumber()).to.equal(350_000);
  });

  it("lock_channel_funds rejects a token id that does not match the channel", async () => {
    await registerTestToken(SECOND_CHANNEL_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const primaryTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const secondChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_CHANNEL_TOKEN_ID,
      { payeeOwnerSigner: payee.wallet }
    );

    await depositToParticipant(
      payer.wallet,
      secondChannel.payerParticipantPda,
      primaryTokenAccount,
      1,
      1_000_000
    );

    await expectProgramError(
      () =>
        program.methods
          .lockChannelFunds(1, new anchor.BN(100_000))
          .accounts({
            payerAccount: secondChannel.payerParticipantPda,
            payeeAccount: secondChannel.payeeParticipantPda,
            channelState: secondChannel.channelPda,
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("request_unlock_channel_funds rejects non-owners", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const outsider = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_000_000
    );
    await program.methods
      .lockChannelFunds(1, new anchor.BN(300_000))
      .accounts({
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .requestUnlockChannelFunds(1, new anchor.BN(100_000))
          .accounts({
            globalConfig: PublicKey.findProgramAddressSync(
              [Buffer.from("global-config")],
              program.programId
            )[0],
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            channelState: ensured.channelPda,
            owner: outsider.wallet.publicKey,
          } as any)
          .signers([outsider.wallet])
          .rpc(),
      "ConstraintSeeds"
    );
  });

  it("request_unlock_channel_funds overwrites the previous request and resets the timer", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_000_000
    );
    await program.methods
      .lockChannelFunds(1, new anchor.BN(400_000))
      .accounts({
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const globalConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    )[0];

    await program.methods
      .requestUnlockChannelFunds(1, new anchor.BN(100_000))
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const afterFirst = await program.account.channelState.fetch(ensured.channelPda);
    await sleep(1200);

    await program.methods
      .requestUnlockChannelFunds(1, new anchor.BN(250_000))
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const afterSecond = await program.account.channelState.fetch(
      ensured.channelPda
    );
    expect(afterSecond.pendingUnlockAmount.toNumber()).to.equal(250_000);
    expect(afterSecond.unlockRequestedAt.toNumber()).to.be.greaterThan(
      afterFirst.unlockRequestedAt.toNumber()
    );
  });

  it("execute_unlock_channel_funds enforces the timelock and releases partial collateral", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });
    const globalConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    )[0];

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );
    await program.methods
      .lockChannelFunds(1, new anchor.BN(500_000))
      .accounts({
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await program.methods
      .requestUnlockChannelFunds(1, new anchor.BN(200_000))
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .executeUnlockChannelFunds(1)
          .accounts({
            globalConfig,
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            channelState: ensured.channelPda,
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "WithdrawalLocked"
    );

    const payerBeforeUnlock = await program.account.participantAccount.fetch(
      ensured.payerParticipantPda
    );

    await sleep(2500);

    await program.methods
      .executeUnlockChannelFunds(1)
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const payerAfterUnlock = await program.account.participantAccount.fetch(
      ensured.payerParticipantPda
    );
    const channelAfterUnlock = await program.account.channelState.fetch(
      ensured.channelPda
    );

    expect(
      getTokenBalance(payerAfterUnlock, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeUnlock, 1).availableBalance.toNumber()
    ).to.equal(200_000);
    expect(channelAfterUnlock.lockedBalance.toNumber()).to.equal(300_000);
    expect(channelAfterUnlock.pendingUnlockAmount.toNumber()).to.equal(0);
    expect(channelAfterUnlock.unlockRequestedAt.toNumber()).to.equal(0);
  });

  it("fully drained pending unlock executes with zero release and clears pending state", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      3_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });
    const globalConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    )[0];

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      2_000_000
    );
    await program.methods
      .lockChannelFunds(1, new anchor.BN(400_000))
      .accounts({
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await program.methods
      .requestUnlockChannelFunds(1, new anchor.BN(250_000))
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const drainMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 400_000),
    });
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: drainMessage,
    });

    const payerBeforeExecute = await program.account.participantAccount.fetch(
      ensured.payerParticipantPda
    );

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: ensured.channelPda,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([payee.wallet])
      .rpc();

    await sleep(2500);

    await program.methods
      .executeUnlockChannelFunds(1)
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const payerAfterExecute = await program.account.participantAccount.fetch(
      ensured.payerParticipantPda
    );
    const channelAfterExecute = await program.account.channelState.fetch(
      ensured.channelPda
    );

    expect(
      getTokenBalance(payerAfterExecute, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeExecute, 1).availableBalance.toNumber()
    ).to.equal(0);
    expect(channelAfterExecute.lockedBalance.toNumber()).to.equal(0);
    expect(channelAfterExecute.pendingUnlockAmount.toNumber()).to.equal(0);
    expect(channelAfterExecute.unlockRequestedAt.toNumber()).to.equal(0);
  });

  it("rotates the authorized signer after the timelock and invalidates the old signer", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const oldSigner = anchor.web3.Keypair.generate();
    const newSigner = anchor.web3.Keypair.generate();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      authorizedSigner: oldSigner.publicKey,
      payeeOwnerSigner: payee.wallet,
    });
    const globalConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    )[0];

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );

    await program.methods
      .requestUpdateChannelAuthorizedSigner(1, newSigner.publicKey)
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const prematureNewSignerMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 100_000),
    });

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: ensured.channelPda,
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            submitter: payee.wallet.publicKey,
          } as any)
          .preInstructions([
            Ed25519Program.createInstructionWithPrivateKey({
              privateKey: newSigner.secretKey,
              message: prematureNewSignerMessage,
            }),
          ])
          .signers([payee.wallet])
          .rpc(),
      "InvalidSignature"
    );

    await expectProgramError(
      () =>
        program.methods
          .executeUpdateChannelAuthorizedSigner(1)
          .accounts({
            globalConfig,
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            channelState: ensured.channelPda,
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "WithdrawalLocked"
    );

    const oldSignerMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 100_000),
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: ensured.channelPda,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([
        Ed25519Program.createInstructionWithPrivateKey({
          privateKey: oldSigner.secretKey,
          message: oldSignerMessage,
        }),
      ])
      .signers([payee.wallet])
      .rpc();

    await sleep(2500);

    await program.methods
      .executeUpdateChannelAuthorizedSigner(1)
      .accounts({
        globalConfig,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        channelState: ensured.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const rotatedChannel = await program.account.channelState.fetch(
      ensured.channelPda
    );
    expect(rotatedChannel.authorizedSigner.toString()).to.equal(
      newSigner.publicKey.toString()
    );
    expect(rotatedChannel.pendingAuthorizedSigner.toString()).to.equal(
      PublicKey.default.toString()
    );

    const postRotationAmount = nextCommitmentAmount(rotatedChannel, 100_000);

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: ensured.channelPda,
            payerAccount: ensured.payerParticipantPda,
            payeeAccount: ensured.payeeParticipantPda,
            submitter: payee.wallet.publicKey,
          } as any)
          .preInstructions([
            Ed25519Program.createInstructionWithPrivateKey({
              privateKey: oldSigner.secretKey,
              message: createCommitmentMessage({
                payerId: rotatedChannel.payerId,
                payeeId: rotatedChannel.payeeId,
                tokenId: 1,
                committedAmount: postRotationAmount,
              }),
            }),
          ])
          .signers([payee.wallet])
          .rpc(),
      "InvalidSignature"
    );

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: ensured.channelPda,
        payerAccount: ensured.payerParticipantPda,
        payeeAccount: ensured.payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([
        Ed25519Program.createInstructionWithPrivateKey({
          privateKey: newSigner.secretKey,
          message: createCommitmentMessage({
            payerId: rotatedChannel.payerId,
            payeeId: rotatedChannel.payeeId,
            tokenId: 1,
            committedAmount: postRotationAmount,
          }),
        }),
      ])
      .signers([payee.wallet])
      .rpc();
  });

  it("respects inbound consent policies when creating permanent channels", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelConsentRequired"
    );

    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.Permissionless)
      .accounts({
        participantAccount: payee.participantPda,
        owner: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    const permissionlessChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      { skipAutoPayeeOwnerSigner: true }
    );
    expect(permissionlessChannel.channel.payerId).to.equal(
      permissionlessChannel.payerParticipant.participantId
    );

    const payee2 = await createTestParticipant();
    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.Disabled)
      .accounts({
        participantAccount: payee2.participantPda,
        owner: payee2.wallet.publicKey,
      } as any)
      .signers([payee2.wallet])
      .rpc();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee2.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelsDisabled"
    );
  });
});
