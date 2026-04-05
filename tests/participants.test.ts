import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  provider,
  deployer,
  feeRecipient,
  user1,
  expectProgramError,
  createTestParticipant,
  ensureChannel,
} from "./shared/setup";

describe("Participant Registration", () => {
  it("should register a participant with zero fee", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const { wallet, participantPda } = await createTestParticipant();

    const participant = await program.account.participantAccount.fetch(
      participantPda
    );
    expect(participant.owner.toString()).to.equal(wallet.publicKey.toString());
    expect(participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId
    );
    expect(participant.tokenBalances.length).to.equal(0);
    expect(participant.openChannelCount.toNumber()).to.equal(0);
    expect(participant.inboundChannelPolicy).to.equal(1);

    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfig.nextParticipantId).to.equal(
      globalConfigBefore.nextParticipantId + 1
    );
  });

  it("initialize_participant: rejects InvalidFeeRecipient (fee_recipient mismatch)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const wrongFeeRecipient = user1.publicKey;
    const freshUser = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        freshUser.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    await expectProgramError(
      () =>
        program.methods
          .initializeParticipant()
          .accounts({
            owner: freshUser.publicKey,
            feeRecipient: wrongFeeRecipient,
          } as any)
          .signers([freshUser])
          .rpc(),
      "InvalidFeeRecipient"
    );
  });

  it("should register user2, user3, and user4", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const created = [];

    for (let i = 0; i < 3; i++) {
      created.push(await createTestParticipant());
    }

    const globalConfigAfter = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfigAfter.nextParticipantId).to.equal(
      globalConfigBefore.nextParticipantId + 3
    );
    expect(created[0].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId
    );
    expect(created[1].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId + 1
    );
    expect(created[2].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId + 2
    );
  });

  it("defaults new participants to ConsentRequired for inbound channels", async () => {
    const participant = await createTestParticipant();
    const freshPayer = await createTestParticipant();

    const stored = await program.account.participantAccount.fetch(
      participant.participantPda
    );
    expect(stored.inboundChannelPolicy).to.equal(1);

    await expectProgramError(
      () =>
        ensureChannel(freshPayer.wallet, participant.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelConsentRequired"
    );
  });

  it("should register participant with non-zero fee", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const user5 = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user5.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    const registrationFee = 1_000_000;
    await program.methods
      .updateConfig(null, null, null, new anchor.BN(registrationFee))
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user5.publicKey.toBytes()],
      program.programId
    );
    const user5BalBefore = await provider.connection.getBalance(
      user5.publicKey
    );
    const feeRecipientBalBefore = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    await program.methods
      .initializeParticipant()
      .accounts({
        owner: user5.publicKey,
        feeRecipient: feeRecipient.publicKey,
      } as any)
      .signers([user5])
      .rpc();
    const user5BalAfter = await provider.connection.getBalance(user5.publicKey);
    const feeRecipientBalAfter = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    expect(user5BalBefore - user5BalAfter).to.be.at.least(registrationFee);
    expect(feeRecipientBalAfter - feeRecipientBalBefore).to.equal(
      registrationFee,
      "Fee recipient must receive registration fee"
    );

    await program.methods
      .updateConfig(null, null, null, new anchor.BN(0))
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();
  });
});

describe("Close Participant", () => {
  it("should close participant with zero balance", async () => {
    const { wallet, participantPda } = await createTestParticipant();

    await program.methods
      .closeParticipant()
      .accounts({
        participantAccount: participantPda,
        owner: wallet.publicKey,
      } as any)
      .signers([wallet])
      .rpc();

    const participant = await program.account.participantAccount.fetchNullable(
      participantPda
    );
    expect(participant).to.equal(null);
  });

  it("should reject closing a participant while a channel is still open", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channelPda } = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1
    );

    await expectProgramError(
      () =>
        program.methods
          .closeParticipant()
          .accounts({
            participantAccount: payer.participantPda,
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "OpenChannelsExist"
    );

    await program.methods
      .executeCloseChannelInstant(1)
      .accounts({
        payerAccount: payer.participantPda,
        payeeAccount: payee.participantPda,
        channelState: channelPda,
        owner: payer.wallet.publicKey,
        rentRecipient: payer.wallet.publicKey,
        payeeSigner: payee.wallet.publicKey,
      } as any)
      .signers([payer.wallet, payee.wallet])
      .rpc();

    await program.methods
      .closeParticipant()
      .accounts({
        participantAccount: payer.participantPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const participant = await program.account.participantAccount.fetchNullable(
      payer.participantPda
    );
    expect(participant).to.equal(null);
  });
});
