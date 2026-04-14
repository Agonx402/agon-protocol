import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  program,
  provider,
  primaryMint,
  deployer,
  user1,
  user2,
  user4,
  expectProgramError,
  createTestParticipant,
  ensureChannel,
  createCommitmentMessage,
  nextCommitmentAmount,
  findParticipantPda,
  findVaultTokenAccountPda,
  findTokenRegistryPda,
  sleep,
  registerTestToken,
  createFundedTokenAccount,
  getFeeRecipientTokenAccount,
  parseProgramEvents,
  findChannelPda,
  createCrossInstructionMessageEd25519Instruction,
  createMultiMessageEd25519Instruction,
  createMultiSigEd25519Instruction,
  createClearingRoundMessage,
  getTokenBalance,
  TEST_CHAIN_ID,
} from "./shared/setup";

const SECOND_TOKEN_ID = 2;
const EVENT_TOKEN_ID = 3;
const CHANNEL_EVENT_TOKEN_ID = 4;
const HIGH_DECIMAL_TOKEN_ID = 15;
const NON_ASCII_TOKEN_ID = 16;

describe("Audit Regressions", () => {
  it("rejects settling a token commitment against a channel for a different token", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const payerParticipantPda = findParticipantPda(user1.publicKey);
    const payerSecondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      25_000_000
    );

    await program.methods
      .deposit(SECOND_TOKEN_ID, new anchor.BN(10_000_000))
      .accounts({
        owner: user1.publicKey,
        participantAccount: payerParticipantPda,
        ownerTokenAccount: payerSecondTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(SECOND_TOKEN_ID),
      } as any)
      .signers([user1])
      .rpc();

    const token1Channel = await ensureChannel(user1, user4.publicKey, 1);
    const token2Channel = await ensureChannel(
      user1,
      user4.publicKey,
      SECOND_TOKEN_ID
    );

    const message = createCommitmentMessage({
      payerId: token2Channel.channel.payerId,
      payeeId: token2Channel.channel.payeeId,
      amount: nextCommitmentAmount(token2Channel.channel, 1_000_000),
      tokenId: SECOND_TOKEN_ID,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message,
    });

    await expectProgramError(
      () =>
        program.methods
          .settleIndividual()
          .accounts({
            channelState: token1Channel.channelPda,
            payerAccount: token1Channel.payerParticipantPda,
            payeeAccount: token1Channel.payeeParticipantPda,
            submitter: user4.publicKey,
          } as any)
          .preInstructions([ed25519Ix])
          .signers([user4])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("rejects Ed25519 instructions that reference message bytes from another instruction", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda } =
      await ensureChannel(user1, user4.publicKey, 1);

    const settleIx = await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: user4.publicKey,
      } as any)
      .instruction();

    const ed25519Ix = createCrossInstructionMessageEd25519Instruction(
      user1,
      Buffer.from(settleIx.data),
      1
    );

    const tx = new anchor.web3.Transaction().add(ed25519Ix, settleIx);

    await expectProgramError(
      () => provider.sendAndConfirm(tx, [user4]),
      "InvalidEd25519Data"
    );
  });


  it("rejects executing a withdrawal to a destination different from the requested token account", async () => {
    const participant = await createTestParticipant();
    const legitimateDestination = await createFundedTokenAccount(
      participant.wallet,
      primaryMint,
      20_000_000
    );
    const attackerDestination = await createFundedTokenAccount(
      user2,
      primaryMint,
      0
    );

    await program.methods
      .deposit(1, new anchor.BN(8_000_000))
      .accounts({
        owner: participant.wallet.publicKey,
        participantAccount: participant.participantPda,
        ownerTokenAccount: legitimateDestination,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([participant.wallet])
      .rpc();

    await program.methods
      .requestWithdrawal(1, new anchor.BN(2_000_000), legitimateDestination)
      .accounts({
        owner: participant.wallet.publicKey,
        participantAccount: participant.participantPda,
        withdrawalDestination: legitimateDestination,
      } as any)
      .signers([participant.wallet])
      .rpc();

    await sleep(3500);

    await expectProgramError(
      () =>
        program.methods
          .executeWithdrawalTimelocked(1)
          .accounts({
            participantAccount: participant.participantPda,
            withdrawalDestination: attackerDestination,
            feeRecipientTokenAccount: getFeeRecipientTokenAccount(1),
          } as any)
          .rpc(),
      "InvalidWithdrawalDestination"
    );

    await program.methods
      .executeWithdrawalTimelocked(1)
      .accounts({
        participantAccount: participant.participantPda,
        withdrawalDestination: legitimateDestination,
        feeRecipientTokenAccount: getFeeRecipientTokenAccount(1),
      } as any)
      .rpc();
  });

  it("supports fee collection for withdrawals of a second registered token", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const participant = await createTestParticipant();
    const destination = await createFundedTokenAccount(
      participant.wallet,
      secondToken.mint,
      15_000_000
    );
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_TOKEN_ID);

    await program.methods
      .deposit(SECOND_TOKEN_ID, new anchor.BN(10_000_000))
      .accounts({
        owner: participant.wallet.publicKey,
        participantAccount: participant.participantPda,
        ownerTokenAccount: destination,
        vaultTokenAccount,
      } as any)
      .signers([participant.wallet])
      .rpc();

    await program.methods
      .requestWithdrawal(
        SECOND_TOKEN_ID,
        new anchor.BN(10_000_000),
        destination
      )
      .accounts({
        owner: participant.wallet.publicKey,
        participantAccount: participant.participantPda,
        withdrawalDestination: destination,
      } as any)
      .signers([participant.wallet])
      .rpc();

    await sleep(3500);

    const destinationBefore = (
      await getAccount(provider.connection, destination)
    ).amount;
    const feeRecipientBefore = (
      await getAccount(
        provider.connection,
        secondToken.feeRecipientTokenAccount
      )
    ).amount;
    const vaultBefore = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    await program.methods
      .executeWithdrawalTimelocked(SECOND_TOKEN_ID)
      .accounts({
        participantAccount: participant.participantPda,
        withdrawalDestination: destination,
        feeRecipientTokenAccount: secondToken.feeRecipientTokenAccount,
      } as any)
      .rpc();

    const destinationAfter = (
      await getAccount(provider.connection, destination)
    ).amount;
    const feeRecipientAfter = (
      await getAccount(
        provider.connection,
        secondToken.feeRecipientTokenAccount
      )
    ).amount;
    const vaultAfter = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    const netReceived = Number(destinationAfter - destinationBefore);
    const feeReceived = Number(feeRecipientAfter - feeRecipientBefore);
    const vaultDecrease = Number(vaultBefore - vaultAfter);

    expect(netReceived).to.equal(9_950_000);
    expect(feeReceived).to.equal(50_000);
    expect(vaultDecrease).to.equal(netReceived + feeReceived);
  });

  it("rejects registering tokens with unsupported decimals", async () => {
    const highDecimalMint = await createMint(
      provider.connection,
      deployer,
      deployer.publicKey,
      null,
      21,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await expectProgramError(
      () =>
        program.methods
          .registerToken(HIGH_DECIMAL_TOKEN_ID, [...Buffer.from("HIDECIM\x00")])
          .accounts({
            mint: highDecimalMint,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidTokenDecimals"
    );
  });

  it("rejects registering tokens with non-ASCII symbols", async () => {
    const mint = await createMint(
      provider.connection,
      deployer,
      deployer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await expectProgramError(
      () =>
        program.methods
          .registerToken(NON_ASCII_TOKEN_ID, [0xff, 0, 0, 0, 0, 0, 0, 0])
          .accounts({
            mint,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidTokenSymbol"
    );
  });

  it("rejects unlocking channel funds with a mismatched token id", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const payerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      secondToken.mint,
      5_000_000
    );

    await program.methods
      .deposit(SECOND_TOKEN_ID, new anchor.BN(2_000_000))
      .accounts({
        owner: payer.wallet.publicKey,
        participantAccount: payer.participantPda,
        ownerTokenAccount: payerTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(SECOND_TOKEN_ID),
      } as any)
      .signers([payer.wallet])
      .rpc();

    const channel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_TOKEN_ID
    );

    await program.methods
      .lockChannelFunds(SECOND_TOKEN_ID, new anchor.BN(500_000))
      .accounts({
        payerAccount: channel.payerParticipantPda,
        payeeAccount: channel.payeeParticipantPda,
        channelState: channel.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await program.methods
      .requestUnlockChannelFunds(SECOND_TOKEN_ID, new anchor.BN(200_000))
      .accounts({
        globalConfig: PublicKey.findProgramAddressSync(
          [Buffer.from("global-config")],
          program.programId
        )[0],
        payerAccount: channel.payerParticipantPda,
        payeeAccount: channel.payeeParticipantPda,
        channelState: channel.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();

    await sleep(3500);

    await expectProgramError(
      () =>
        program.methods
          .executeUnlockChannelFunds(1)
          .accounts({
            globalConfig: PublicKey.findProgramAddressSync(
              [Buffer.from("global-config")],
              program.programId
            )[0],
            payerAccount: channel.payerParticipantPda,
            payeeAccount: channel.payeeParticipantPda,
            channelState: channel.channelPda,
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "InvalidTokenMint"
    );

    await program.methods
      .executeUnlockChannelFunds(SECOND_TOKEN_ID)
      .accounts({
        globalConfig: PublicKey.findProgramAddressSync(
          [Buffer.from("global-config")],
          program.programId
        )[0],
        payerAccount: channel.payerParticipantPda,
        payeeAccount: channel.payeeParticipantPda,
        channelState: channel.channelPda,
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();
  });

  it("allows back-to-back multilateral rounds when target cumulatives keep increasing", async () => {
    const participantA = await createTestParticipant();
    const participantB = await createTestParticipant();
    const participantATokenAccount = await createFundedTokenAccount(
      participantA.wallet,
      primaryMint,
      8_000_000
    );
    const participantBTokenAccount = await createFundedTokenAccount(
      participantB.wallet,
      primaryMint,
      8_000_000
    );

    await program.methods
      .deposit(1, new anchor.BN(4_000_000))
      .accounts({
        owner: participantA.wallet.publicKey,
        participantAccount: participantA.participantPda,
        ownerTokenAccount: participantATokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([participantA.wallet])
      .rpc();

    await program.methods
      .deposit(1, new anchor.BN(4_000_000))
      .accounts({
        owner: participantB.wallet.publicKey,
        participantAccount: participantB.participantPda,
        ownerTokenAccount: participantBTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([participantB.wallet])
      .rpc();

    const channelAB = await ensureChannel(
      participantA.wallet,
      participantB.wallet.publicKey,
      1
    );
    const channelBA = await ensureChannel(
      participantB.wallet,
      participantA.wallet.publicKey,
      1
    );

    const buildMessage = async (grossAmount: number) => {
      const currentAB = await program.account.channelState.fetch(
        channelAB.channelPda
      );
      const currentBA = await program.account.channelState.fetch(
        channelBA.channelPda
      );
      return createClearingRoundMessage({
        tokenId: 1,
        blocks: [
          {
            participantId: channelAB.payerParticipant.participantId,
            entries: [
              {
                payeeRef: 1,
                targetCumulative: new anchor.BN(
                  currentAB.settledCumulative.toString()
                ).add(new anchor.BN(grossAmount)),
              },
            ],
          },
          {
            participantId: channelBA.payerParticipant.participantId,
            entries: [
              {
                payeeRef: 0,
                targetCumulative: new anchor.BN(
                  currentBA.settledCumulative.toString()
                ).add(new anchor.BN(grossAmount)),
              },
            ],
          },
        ],
      });
    };

    const firstMessage = await buildMessage(750_000);
    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: participantA.wallet.publicKey,
      } as any)
      .remainingAccounts([
        {
          pubkey: participantA.participantPda,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: participantB.participantPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: channelAB.channelPda, isSigner: false, isWritable: true },
        { pubkey: channelBA.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([
        createMultiSigEd25519Instruction(
          [participantA.wallet, participantB.wallet],
          firstMessage
        ),
      ])
      .signers([participantA.wallet])
      .rpc();

    const secondMessage = await buildMessage(500_000);
    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: participantA.wallet.publicKey,
      } as any)
      .remainingAccounts([
        {
          pubkey: participantA.participantPda,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: participantB.participantPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: channelAB.channelPda, isSigner: false, isWritable: true },
        { pubkey: channelBA.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([
        createMultiSigEd25519Instruction(
          [participantA.wallet, participantB.wallet],
          secondMessage
        ),
      ])
      .signers([participantA.wallet])
      .rpc();

    const finalChannelAB = await program.account.channelState.fetch(
      channelAB.channelPda
    );
    const finalChannelBA = await program.account.channelState.fetch(
      channelBA.channelPda
    );

    expect(finalChannelAB.settledCumulative.toNumber()).to.equal(
      channelAB.channel.settledCumulative.toNumber() + 1_250_000
    );
    expect(finalChannelBA.settledCumulative.toNumber()).to.equal(
      channelBA.channel.settledCumulative.toNumber() + 1_250_000
    );
  });

  it("rejects multilateral rounds that omit a participant who would receive a net credit", async () => {
    const participantA = await createTestParticipant();
    const participantB = await createTestParticipant();
    const participantATokenAccount = await createFundedTokenAccount(
      participantA.wallet,
      primaryMint,
      4_000_000
    );

    await program.methods
      .deposit(1, new anchor.BN(2_000_000))
      .accounts({
        owner: participantA.wallet.publicKey,
        participantAccount: participantA.participantPda,
        ownerTokenAccount: participantATokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
      } as any)
      .signers([participantA.wallet])
      .rpc();

    const channelAB = await ensureChannel(
      participantA.wallet,
      participantB.wallet.publicKey,
      1
    );
    const currentAB = await program.account.channelState.fetch(
      channelAB.channelPda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: channelAB.payerParticipant.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: new anchor.BN(
                currentAB.settledCumulative.toString()
              ).add(new anchor.BN(750_000)),
            },
          ],
        },
      ],
    });

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound()
          .accounts({
            submitter: participantA.wallet.publicKey,
          } as any)
          .remainingAccounts([
            {
              pubkey: participantA.participantPda,
              isSigner: false,
              isWritable: true,
            },
            { pubkey: channelAB.channelPda, isSigner: false, isWritable: true },
          ])
          .preInstructions([
            createMultiSigEd25519Instruction([participantA.wallet], message),
          ])
          .signers([participantA.wallet])
          .rpc(),
      "InvalidClearingRoundMessage"
    );
  });

  it("rejects clearing rounds signed for a different message domain", async () => {
    const channel = await ensureChannel(user1, user4.publicKey, 1);
    const message = createClearingRoundMessage({
      tokenId: 1,
      messageDomain: Buffer.alloc(16, 5),
      blocks: [
        {
          participantId: channel.payerParticipant.participantId,
          entries: [
            {
              payeeRef: 1,
              targetCumulative: new anchor.BN(
                channel.channel.settledCumulative.toString()
              ).add(new anchor.BN(250_000)),
            },
          ],
        },
        {
          participantId: channel.payeeParticipant.participantId,
          entries: [],
        },
      ],
    });

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound()
          .accounts({
            submitter: user1.publicKey,
          } as any)
          .remainingAccounts([
            {
              pubkey: channel.payerParticipantPda,
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: channel.payeeParticipantPda,
              isSigner: false,
              isWritable: true,
            },
            { pubkey: channel.channelPda, isSigner: false, isWritable: true },
          ])
          .preInstructions([
            createMultiSigEd25519Instruction([user1, user4], message),
          ])
          .signers([user1])
          .rpc(),
      "InvalidMessageDomain"
    );
  });

  it("uses a two-step token registry authority handoff", async () => {
    const [tokenRegistryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token-registry")],
      program.programId
    );
    const newAuthority = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
    );

    await program.methods
      .updateRegistryAuthority(newAuthority.publicKey)
      .accounts({
        tokenRegistry: tokenRegistryPda,
        currentAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    let registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(registry.pendingAuthority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );

    await expectProgramError(
      () =>
        program.methods
          .acceptRegistryAuthority()
          .accounts({
            tokenRegistry: tokenRegistryPda,
            pendingAuthority: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "UnauthorizedPendingAuthority"
    );

    await program.methods
      .acceptRegistryAuthority()
      .accounts({
        tokenRegistry: tokenRegistryPda,
        pendingAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(registry.pendingAuthority.toString()).to.equal(
      anchor.web3.PublicKey.default.toString()
    );

    await program.methods
      .updateRegistryAuthority(deployer.publicKey)
      .accounts({
        tokenRegistry: tokenRegistryPda,
        currentAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    await program.methods
      .acceptRegistryAuthority()
      .accounts({
        tokenRegistry: tokenRegistryPda,
        pendingAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
  });

  it("emits token_id on deposit events for allowlisted tokens", async () => {
    const eventToken = await registerTestToken(EVENT_TOKEN_ID, "PYUSD");
    const participant = await createTestParticipant();
    const participantTokenAccount = await createFundedTokenAccount(
      participant.wallet,
      eventToken.mint,
      5_000_000
    );

    const signature = await program.methods
      .deposit(EVENT_TOKEN_ID, new anchor.BN(1_000_000))
      .accounts({
        owner: participant.wallet.publicKey,
        participantAccount: participant.participantPda,
        ownerTokenAccount: participantTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(EVENT_TOKEN_ID),
      } as any)
      .signers([participant.wallet])
      .rpc();

    const events = await parseProgramEvents(signature);
    const deposited = events.find(
      (event) => event.name === "Deposited" || event.name === "deposited"
    );

    expect(deposited, "Deposited event should be present").to.exist;
    expect(deposited!.data.tokenId).to.equal(EVENT_TOKEN_ID);
    expect(deposited!.data.participantId).to.equal(
      participant.participant.participantId
    );
    expect(deposited!.data.amount.toNumber()).to.equal(1_000_000);
  });

  it("emits token_id on channel creation events for non-default allowlisted tokens", async () => {
    await registerTestToken(CHANNEL_EVENT_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const channelPda = findChannelPda(
      payer.participant.participantId,
      payee.participant.participantId,
      CHANNEL_EVENT_TOKEN_ID
    );

    const signature = await program.methods
      .createChannel(CHANNEL_EVENT_TOKEN_ID, null)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        owner: payer.wallet.publicKey,
        payerAccount: payer.participantPda,
        payeeAccount: payee.participantPda,
        payeeOwner: payee.wallet.publicKey,
        channelState: channelPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer.wallet, payee.wallet])
      .rpc();

    const events = await parseProgramEvents(signature);
    const channelCreated = events.find(
      (event) =>
        event.name === "ChannelCreated" || event.name === "channelCreated"
    );

    expect(channelCreated, "ChannelCreated event should be present").to.exist;
    expect(channelCreated!.data.tokenId).to.equal(CHANNEL_EVENT_TOKEN_ID);
    expect(channelCreated!.data.payerId).to.equal(
      payer.participant.participantId
    );
    expect(channelCreated!.data.payeeId).to.equal(
      payee.participant.participantId
    );
  });
});
