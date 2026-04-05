import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  user1,
  user2,
  user3,
  createTestParticipant,
  ensureChannel,
  findParticipantPda,
  findChannelPda,
  findLaneStatePda,
  findTokenRegistryPda,
  sleep,
  expectProgramError,
  getTokenBalance,
  INBOUND_CHANNEL_POLICY,
  registerTestToken,
} from "./shared/setup";

const SECOND_CHANNEL_TOKEN_ID = 13;

describe("Channel Close", () => {
  it("should request close channel (user1->user2)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const [payerParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );
    const [payeeParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user2.publicKey.toBytes()],
      program.programId
    );
    const channelPda = findChannelPda(0, 1, 1);

    try {
      await program.account.channelState.fetch(channelPda);
    } catch {
      await program.methods
        .createChannel(1, null)
        .accounts({
          tokenRegistry: findTokenRegistryPda(),
          owner: user1.publicKey,
          payerAccount: payerParticipantPda,
          payeeAccount: payeeParticipantPda,
          laneState: findLaneStatePda(0, 1, 1),
          payeeOwner: user2.publicKey,
          channelState: channelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user1, user2])
        .rpc();
    }

    await program.methods
      .requestCloseChannel(1) // token_id = 1 (primary token)
      .accounts({
        channelState: channelPda,
        requester: user1.publicKey,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
      } as any)
      .signers([user1])
      .rpc();

    const channel = await program.account.channelState.fetch(channelPda);
    expect(channel.closeRequestedAt.toNumber()).to.be.greaterThan(0);
  });

  it("should execute_close_channel_instant with payee consent (user1->user3)", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user3.publicKey, 1);

    await program.methods
      .executeCloseChannelInstant(1) // token_id = 1 (primary token)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        owner: user1.publicKey,
        rentRecipient: user1.publicKey,
        payeeSigner: user3.publicKey,
      } as any)
      .signers([user1, user3])
      .rpc();

    // Channel should be closed (account deleted)
    try {
      await program.account.channelState.fetch(channelPda);
      expect.fail("Channel should be closed");
    } catch (e: any) {
      expect(e.message || e.toString()).to.include("Account does not exist");
    }
  });

  it("execute_close_channel_instant: rejects InvalidRentRecipient", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user3.publicKey, 1);

    await expectProgramError(
      () =>
        program.methods
          .executeCloseChannelInstant(1) // token_id = 1 (primary token)
          .accounts({
            payerAccount: payerParticipantPda,
            payeeAccount: payeeParticipantPda,
            channelState: channelPda,
            owner: user1.publicKey,
            rentRecipient: user2.publicKey, // must equal payer_account.owner to succeed
            payeeSigner: user3.publicKey,
          } as any)
          .signers([user1, user3])
          .rpc(),
      "InvalidRentRecipient"
    );

    // Channel must still exist after failed close
    const channel = await program.account.channelState.fetch(channelPda);
    expect(channel.settledCumulative.toNumber()).to.equal(0);
  });

  it("should execute_close_channel after timelock (user1->user2)", async () => {
    const payerParticipantPda = findParticipantPda(user1.publicKey);
    const payeeParticipantPda = findParticipantPda(user2.publicKey);
    const [channelPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("channel-v1"),
        new Uint8Array(new Uint32Array([0]).buffer),
        new Uint8Array(new Uint32Array([1]).buffer),
        new Uint8Array(new Uint16Array([1]).buffer),
      ],
      program.programId
    );

    await sleep(3500);

    await program.methods
      .executeCloseChannel(1) // token_id = 1 (primary token)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        rentRecipient: user1.publicKey,
      } as any)
      .rpc();

    try {
      await program.account.channelState.fetch(channelPda);
      expect.fail("Channel should be closed");
    } catch (e: any) {
      expect(e.message || e.toString()).to.include("Account does not exist");
    }
  });

  it("should execute_close_channel with locked collateral (returns to payer)", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user2, user3.publicKey, 1);

    const lockAmount = 100_000;
    await program.methods
      .lockChannelFunds(1, new anchor.BN(lockAmount)) // token_id = 1 (primary token)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        owner: user2.publicKey,
      } as any)
      .signers([user2])
      .rpc();

    await program.methods
      .requestCloseChannel(1) // token_id = 1 (primary token)
      .accounts({
        payerAccount: payerParticipantPda,
        channelState: channelPda,
        requester: user2.publicKey,
        payeeAccount: payeeParticipantPda,
      } as any)
      .signers([user2])
      .rpc();

    await sleep(3500);

    const payerBeforeClose = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    await program.methods
      .executeCloseChannel(1) // token_id = 1 (primary token)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        rentRecipient: user2.publicKey,
      } as any)
      .rpc();
    const payerAfterClose = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    expect(
      getTokenBalance(payerAfterClose, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeClose, 1).availableBalance.toNumber()
    ).to.equal(lockAmount);
  });

  it("should create distinct channels per token for the same payer and payee", async () => {
    await registerTestToken(SECOND_CHANNEL_TOKEN_ID, "EURC");

    const firstChannel = await ensureChannel(user1, user2.publicKey, 1);
    const secondChannel = await ensureChannel(
      user1,
      user2.publicKey,
      SECOND_CHANNEL_TOKEN_ID
    );

    expect(firstChannel.channelPda.toString()).to.not.equal(
      secondChannel.channelPda.toString()
    );
    expect(firstChannel.channel.tokenId).to.equal(1);
    expect(secondChannel.channel.tokenId).to.equal(SECOND_CHANNEL_TOKEN_ID);
    expect(
      secondChannel.channelPda.toString(),
      "channel PDA must include token_id in its seeds"
    ).to.equal(
      findChannelPda(
        firstChannel.payerParticipant.participantId,
        firstChannel.payeeParticipant.participantId,
        SECOND_CHANNEL_TOKEN_ID
      ).toString()
    );
  });

  it("allows the payee to start unilateral close and unwind an unsolicited inbound channel", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    await program.methods
      .requestCloseChannel(1)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        requester: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    await sleep(3500);

    await program.methods
      .executeCloseChannel(1)
      .accounts({
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        channelState: channelPda,
        rentRecipient: payer.wallet.publicKey,
      } as any)
      .rpc();

    await program.methods
      .closeParticipant()
      .accounts({
        participantAccount: payeeParticipantPda,
        owner: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    try {
      await program.account.participantAccount.fetch(payeeParticipantPda);
      expect.fail("Participant should be closed after unwinding the inbound channel");
    } catch (e: any) {
      expect(e.message || e.toString()).to.include("Account does not exist");
    }
  });

  it("requires payee consent when the inbound policy is ConsentRequired", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.ConsentRequired)
      .accounts({
        participantAccount: payee.participantPda,
        owner: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelConsentRequired"
    );

    await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });
  });

  it("rejects unsolicited inbound channels when the policy is Disabled", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.Disabled)
      .accounts({
        participantAccount: payee.participantPda,
        owner: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelsDisabled"
    );
  });
});
