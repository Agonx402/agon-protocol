import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  TEST_CHAIN_ID,
  createClearingRoundMessage,
  createCommitmentMessage,
  createFundedTokenAccount,
  createMultiMessageEd25519Instruction,
  createMultiSigEd25519Instruction,
  createTestParticipant,
  ensureChannel,
  expectProgramError,
  fetchParticipant,
  findParticipantPda,
  findVaultTokenAccountPda,
  getTokenBalance,
  nextCommitmentAmount,
  primaryMint,
  program,
  registerTestToken,
  user1,
  user1TokenAccount,
  user3,
  user4,
} from "./shared/setup";

const SECOND_SETTLEMENT_TOKEN_ID = 14;

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

function availableDelta(after: any, before: any, tokenId: number): number {
  return (
    getTokenBalance(after, tokenId).availableBalance.toNumber() -
    getTokenBalance(before, tokenId).availableBalance.toNumber()
  );
}

describe("Settle Individual", () => {
  it("should settle individual commitment (user1->user4)", async () => {
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(user1, user4.publicKey, 1);

    await depositToVault(
      user1,
      payerParticipantPda,
      user1TokenAccount,
      1,
      3_000_000
    );

    const msg = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 2_000_000),
      tokenId: 1,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: msg,
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
        submitter: user4.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([user4])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfter = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    expect(availableDelta(payerAfter, payerBefore, 1)).to.equal(-2_000_000);
    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(2_000_000);
  });

  it("should settle individual commitment for a second allowlisted token", async () => {
    const secondToken = await registerTestToken(
      SECOND_SETTLEMENT_TOKEN_ID,
      "USDT"
    );
    const payerParticipantPda = findParticipantPda(user1.publicKey);
    const payerSecondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      20_000_000
    );

    await depositToVault(
      user1,
      payerParticipantPda,
      payerSecondTokenAccount,
      SECOND_SETTLEMENT_TOKEN_ID,
      5_000_000
    );

    const {
      channelPda,
      payerParticipantPda: ensuredPayerParticipantPda,
      payeeParticipantPda,
      channel,
    } = await ensureChannel(user1, user4.publicKey, SECOND_SETTLEMENT_TOKEN_ID);

    const message = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      amount: nextCommitmentAmount(channel, 1_500_000),
      tokenId: SECOND_SETTLEMENT_TOKEN_ID,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
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
        payerAccount: ensuredPayerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: user4.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([user4])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfter = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    expect(
      availableDelta(payerAfter, payerBefore, SECOND_SETTLEMENT_TOKEN_ID)
    ).to.equal(-1_500_000);
    expect(
      availableDelta(payeeAfter, payeeBefore, SECOND_SETTLEMENT_TOKEN_ID)
    ).to.equal(1_500_000);
  });

  it("should settle a higher cumulative commitment without intermediate checkpoints", async () => {
    const payer = await createPrimaryFundedParticipant(6_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const firstMessage = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      committedAmount: nextCommitmentAmount(channel, 1_000_000),
      tokenId: 1,
    });

    const firstEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: firstMessage,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([firstEd25519Ix])
      .signers([payee.wallet])
      .rpc();

    const channelAfterFirst = await program.account.channelState.fetch(
      channelPda
    );
    const payerBeforeSecond = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeBeforeSecond = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    const secondTarget = nextCommitmentAmount(channelAfterFirst, 1_500_000);
    const secondMessage = createCommitmentMessage({
      payerId: channelAfterFirst.payerId,
      payeeId: channelAfterFirst.payeeId,
      committedAmount: secondTarget,
      tokenId: 1,
    });

    const secondEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: secondMessage,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([secondEd25519Ix])
      .signers([payee.wallet])
      .rpc();

    const payerAfterSecond = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfterSecond = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );
    const channelAfterSecond = await program.account.channelState.fetch(
      channelPda
    );

    expect(availableDelta(payerAfterSecond, payerBeforeSecond, 1)).to.equal(
      -1_500_000
    );
    expect(availableDelta(payeeAfterSecond, payeeBeforeSecond, 1)).to.equal(
      1_500_000
    );
    expect(channelAfterSecond.settledCumulative.toNumber()).to.equal(
      secondTarget.toNumber()
    );
  });

  it("should settle commitment bundle (many buyers -> one payee)", async () => {
    const payee = await createTestParticipant();
    const payers = await Promise.all([
      createPrimaryFundedParticipant(6_000_000),
      createPrimaryFundedParticipant(6_000_000),
    ]);
    const deltas = [1_000_000, 1_500_000];

    const channels = await Promise.all(
      payers.map(async (payer) => {
        const ensured = await ensureChannel(
          payer.wallet,
          payee.wallet.publicKey,
          1
        );
        return {
          payer,
          ...ensured,
        };
      })
    );

    const payeeBefore = await program.account.participantAccount.fetch(
      payee.participantPda
    );
    const payerBalancesBefore = await Promise.all(
      channels.map(({ payerParticipantPda }) =>
        program.account.participantAccount.fetch(payerParticipantPda)
      )
    );

    const bundleEntries = channels.map(({ payer, channel }, index) => ({
      signer: payer.wallet,
      message: createCommitmentMessage({
        payerId: channel.payerId,
        payeeId: channel.payeeId,
        committedAmount: nextCommitmentAmount(channel, deltas[index]),
        tokenId: 1,
      }),
    }));

    const bundledEd25519Ix =
      createMultiMessageEd25519Instruction(bundleEntries);

    await program.methods
      .settleCommitmentBundle(bundleEntries.length)
      .accounts({
        payeeAccount: payee.participantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .remainingAccounts(
        channels.flatMap(({ payerParticipantPda, channelPda }) => [
          { pubkey: payerParticipantPda, isSigner: false, isWritable: true },
          { pubkey: channelPda, isSigner: false, isWritable: true },
        ])
      )
      .preInstructions([bundledEd25519Ix])
      .signers([payee.wallet])
      .rpc();

    const payeeAfter = await program.account.participantAccount.fetch(
      payee.participantPda
    );
    const payerBalancesAfter = await Promise.all(
      channels.map(({ payerParticipantPda }) =>
        program.account.participantAccount.fetch(payerParticipantPda)
      )
    );
    const channelsAfter = await Promise.all(
      channels.map(({ channelPda }) =>
        program.account.channelState.fetch(channelPda)
      )
    );

    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(
      deltas.reduce((sum, value) => sum + value, 0)
    );
    payerBalancesAfter.forEach((payerAfter, index) => {
      expect(
        availableDelta(payerAfter, payerBalancesBefore[index], 1)
      ).to.equal(-deltas[index]);
      expect(channelsAfter[index].settledCumulative.toNumber()).to.equal(
        deltas[index]
      );
    });
  });

  it("rejects bundle settlement when count does not match the signature count", async () => {
    const payee = await createTestParticipant();
    const payer = await createPrimaryFundedParticipant(4_000_000);
    const extraPayer = await createPrimaryFundedParticipant(4_000_000);
    const primaryChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1
    );
    const extraChannel = await ensureChannel(
      extraPayer.wallet,
      payee.wallet.publicKey,
      1
    );

    const bundleEntries = [
      {
        signer: payer.wallet,
        message: createCommitmentMessage({
          payerId: primaryChannel.channel.payerId,
          payeeId: primaryChannel.channel.payeeId,
          committedAmount: nextCommitmentAmount(primaryChannel.channel, 500_000),
          tokenId: 1,
        }),
      },
      {
        signer: extraPayer.wallet,
        message: createCommitmentMessage({
          payerId: extraChannel.channel.payerId,
          payeeId: extraChannel.channel.payeeId,
          committedAmount: nextCommitmentAmount(extraChannel.channel, 750_000),
          tokenId: 1,
        }),
      },
    ];

    const bundledEd25519Ix =
      createMultiMessageEd25519Instruction(bundleEntries);

    await expectProgramError(
      () =>
        program.methods
          .settleCommitmentBundle(1)
          .accounts({
            payeeAccount: payee.participantPda,
            submitter: payee.wallet.publicKey,
          } as any)
          .remainingAccounts([
            {
              pubkey: primaryChannel.payerParticipantPda,
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: primaryChannel.channelPda,
              isSigner: false,
              isWritable: true,
            },
          ])
          .preInstructions([bundledEd25519Ix])
          .signers([payee.wallet])
          .rpc(),
      "InvalidCommitmentMessage"
    );
  });

  it("should pay an operator through a separate seller->operator lane", async () => {
    const buyer = await createPrimaryFundedParticipant(5_000_000);
    const seller = await createTestParticipant();
    const operator = await createTestParticipant();
    const buyerToSeller = await ensureChannel(
      buyer.wallet,
      seller.wallet.publicKey,
      1
    );
    const sellerToOperator = await ensureChannel(
      seller.wallet,
      operator.wallet.publicKey,
      1
    );

    const paymentAmount = 2_000_000;
    const operatorFee = 50_000;

    const buyerBefore = await program.account.participantAccount.fetch(
      buyerToSeller.payerParticipantPda
    );
    const sellerBefore = await program.account.participantAccount.fetch(
      buyerToSeller.payeeParticipantPda
    );
    const operatorBefore = await program.account.participantAccount.fetch(
      sellerToOperator.payeeParticipantPda
    );

    const buyerMessage = createCommitmentMessage({
      payerId: buyerToSeller.channel.payerId,
      payeeId: buyerToSeller.channel.payeeId,
      committedAmount: nextCommitmentAmount(
        buyerToSeller.channel,
        paymentAmount
      ),
      tokenId: 1,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: buyerToSeller.channelPda,
        payerAccount: buyerToSeller.payerParticipantPda,
        payeeAccount: buyerToSeller.payeeParticipantPda,
        submitter: seller.wallet.publicKey,
      } as any)
      .preInstructions([
        Ed25519Program.createInstructionWithPrivateKey({
          privateKey: buyer.wallet.secretKey,
          message: buyerMessage,
        }),
      ])
      .signers([seller.wallet])
      .rpc();

    const operatorMessage = createCommitmentMessage({
      payerId: sellerToOperator.channel.payerId,
      payeeId: sellerToOperator.channel.payeeId,
      committedAmount: nextCommitmentAmount(
        sellerToOperator.channel,
        operatorFee
      ),
      tokenId: 1,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: sellerToOperator.channelPda,
        payerAccount: sellerToOperator.payerParticipantPda,
        payeeAccount: sellerToOperator.payeeParticipantPda,
        submitter: operator.wallet.publicKey,
      } as any)
      .preInstructions([
        Ed25519Program.createInstructionWithPrivateKey({
          privateKey: seller.wallet.secretKey,
          message: operatorMessage,
        }),
      ])
      .signers([operator.wallet])
      .rpc();

    const buyerAfter = await program.account.participantAccount.fetch(
      buyerToSeller.payerParticipantPda
    );
    const sellerAfter = await program.account.participantAccount.fetch(
      buyerToSeller.payeeParticipantPda
    );
    const operatorAfter = await program.account.participantAccount.fetch(
      sellerToOperator.payeeParticipantPda
    );

    expect(availableDelta(buyerAfter, buyerBefore, 1)).to.equal(-paymentAmount);
    expect(availableDelta(sellerAfter, sellerBefore, 1)).to.equal(
      paymentAmount - operatorFee
    );
    expect(availableDelta(operatorAfter, operatorBefore, 1)).to.equal(
      operatorFee
    );
  });

  it("should settle individual commitment with authorized_settler (fresh payer->fresh payee, user1 submits)", async () => {
    const payer = await createPrimaryFundedParticipant(4_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const message = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      committedAmount: nextCommitmentAmount(channel, 1_500_000),
      tokenId: 1,
      authorizedSettler: user1.publicKey,
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
        submitter: user1.publicKey,
      } as any)
      .preInstructions([ed25519Ix])
      .signers([user1])
      .rpc();

    const payerAfter = await program.account.participantAccount.fetch(
      payerParticipantPda
    );
    const payeeAfter = await program.account.participantAccount.fetch(
      payeeParticipantPda
    );

    expect(availableDelta(payerAfter, payerBefore, 1)).to.equal(-1_500_000);
    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(1_500_000);
  });

  it("should settle clearing rounds with an operator as an ordinary participant", async () => {
    const alice = await createPrimaryFundedParticipant(1_000_000);
    const bob = await createPrimaryFundedParticipant(7_000_000);
    const jon = await createTestParticipant();
    const operator = await createTestParticipant();

    const aliceToOperator = await ensureChannel(
      alice.wallet,
      operator.wallet.publicKey,
      1
    );
    const bobToJon = await ensureChannel(bob.wallet, jon.wallet.publicKey, 1);
    const bobToOperator = await ensureChannel(
      bob.wallet,
      operator.wallet.publicKey,
      1
    );

    const aliceBefore = await program.account.participantAccount.fetch(
      alice.participantPda
    );
    const bobBefore = await program.account.participantAccount.fetch(
      bob.participantPda
    );
    const jonBefore = await program.account.participantAccount.fetch(
      jon.participantPda
    );
    const operatorBefore = await program.account.participantAccount.fetch(
      operator.participantPda
    );

    const message = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: alice.participant.participantId,
          entries: [
            {
              payeeRef: 3,
              targetCumulative: nextCommitmentAmount(
                aliceToOperator.channel,
                250_000
              ),
            },
          ],
        },
        {
          participantId: bob.participant.participantId,
          entries: [
            {
              payeeRef: 2,
              targetCumulative: nextCommitmentAmount(bobToJon.channel, 4_750_000),
            },
            {
              payeeRef: 3,
              targetCumulative: nextCommitmentAmount(
                bobToOperator.channel,
                750_000
              ),
            },
          ],
        },
        {
          participantId: jon.participant.participantId,
          entries: [],
        },
        {
          participantId: operator.participant.participantId,
          entries: [],
        },
      ],
    });

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: alice.wallet.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: alice.participantPda, isSigner: false, isWritable: true },
        { pubkey: bob.participantPda, isSigner: false, isWritable: true },
        { pubkey: jon.participantPda, isSigner: false, isWritable: true },
        { pubkey: operator.participantPda, isSigner: false, isWritable: true },
        { pubkey: aliceToOperator.channelPda, isSigner: false, isWritable: true },
        { pubkey: bobToJon.channelPda, isSigner: false, isWritable: true },
        { pubkey: bobToOperator.channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([
        createMultiSigEd25519Instruction(
          [alice.wallet, bob.wallet, jon.wallet, operator.wallet],
          message
        ),
      ])
      .signers([alice.wallet])
      .rpc();

    const aliceAfter = await program.account.participantAccount.fetch(
      alice.participantPda
    );
    const bobAfter = await program.account.participantAccount.fetch(
      bob.participantPda
    );
    const jonAfter = await program.account.participantAccount.fetch(
      jon.participantPda
    );
    const operatorAfter = await program.account.participantAccount.fetch(
      operator.participantPda
    );

    expect(availableDelta(aliceAfter, aliceBefore, 1)).to.equal(-250_000);
    expect(availableDelta(bobAfter, bobBefore, 1)).to.equal(-5_500_000);
    expect(availableDelta(jonAfter, jonBefore, 1)).to.equal(4_750_000);
    expect(availableDelta(operatorAfter, operatorBefore, 1)).to.equal(1_000_000);
  });

  it("double-charge prevention: settle individual first, then clearing round for same debt fails", async () => {
    const payer = await createPrimaryFundedParticipant(2_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const targetAmount = nextCommitmentAmount(channel, 500_000);
    const commitmentMessage = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      committedAmount: targetAmount,
      tokenId: 1,
    });

    const commitmentEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: commitmentMessage,
    });

    await program.methods
      .settleIndividual()
      .accounts({
        channelState: channelPda,
        payerAccount: payerParticipantPda,
        payeeAccount: payeeParticipantPda,
        submitter: payee.wallet.publicKey,
      } as any)
      .preInstructions([commitmentEd25519Ix])
      .signers([payee.wallet])
      .rpc();

    const clearingRoundMessage = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: channel.payerId,
          entries: [
            {
              payeeRef: 1,
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
      [payer.wallet, payee.wallet],
      clearingRoundMessage
    );

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound()
          .accounts({
            submitter: payer.wallet.publicKey,
          } as any)
          .remainingAccounts([
            { pubkey: payerParticipantPda, isSigner: false, isWritable: true },
            { pubkey: payeeParticipantPda, isSigner: false, isWritable: true },
            { pubkey: channelPda, isSigner: false, isWritable: true },
          ])
          .preInstructions([clearingRoundEd25519Ix])
          .signers([payer.wallet])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });

  it("double-charge prevention: settle clearing round first, then individual for same debt fails", async () => {
    const payer = await createPrimaryFundedParticipant(2_000_000);
    const payee = await createTestParticipant();
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const targetAmount = nextCommitmentAmount(channel, 500_000);
    const clearingRoundMessage = createClearingRoundMessage({
      tokenId: 1,
      blocks: [
        {
          participantId: channel.payerId,
          entries: [
            {
              payeeRef: 1,
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
      [payer.wallet, payee.wallet],
      clearingRoundMessage
    );

    await program.methods
      .settleClearingRound()
      .accounts({
        submitter: payer.wallet.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: payerParticipantPda, isSigner: false, isWritable: true },
        { pubkey: payeeParticipantPda, isSigner: false, isWritable: true },
        { pubkey: channelPda, isSigner: false, isWritable: true },
      ])
      .preInstructions([clearingRoundEd25519Ix])
      .signers([payer.wallet])
      .rpc();

    const commitmentMessage = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      committedAmount: targetAmount,
      tokenId: 1,
    });

    const commitmentEd25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.wallet.secretKey,
      message: commitmentMessage,
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
          .preInstructions([commitmentEd25519Ix])
          .signers([payee.wallet])
          .rpc(),
      "CommitmentAmountMustIncrease"
    );
  });
});
