import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  program,
  provider,
  user1,
  user1TokenAccount,
  feeRecipientTokenAccount,
  findParticipantPda,
  findVaultTokenAccountPda,
  getTokenBalance,
  sleep,
  registerTestToken,
  createFundedTokenAccount,
  getFeeRecipientTokenAccount,
} from "./shared/setup";

const SECOND_WITHDRAWAL_TOKEN_ID = 12;

describe("Withdrawal", () => {
  it("should request withdrawal", async () => {
    const participantPda = findParticipantPda(user1.publicKey);
    const withdrawAmount = 5_000_000; // 5 primary-token units

    await program.methods
      .requestWithdrawal(1, new anchor.BN(withdrawAmount), user1TokenAccount) // token_id = 1
      .accounts({
        owner: user1.publicKey,
        participantAccount: participantPda,
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    const participant = await program.account.participantAccount.fetch(
      participantPda
    );
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(withdrawAmount);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.be.greaterThan(0);
    expect(primaryTokenBalance.withdrawalDestination.toString()).to.equal(
      user1TokenAccount.toString()
    );
  });

  it("should reject execute_withdrawal before timelock", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    try {
      await program.methods
        .executeWithdrawalTimelocked(1) // token_id = 1 (primary token)
        .accounts({
          participantAccount: participantPda,
          withdrawalDestination: user1TokenAccount,
          feeRecipientTokenAccount: feeRecipientTokenAccount,
        } as any)
        .rpc();
      expect.fail("Should have thrown WithdrawalLocked");
    } catch (e: any) {
      expect(e.message || e.toString()).to.include("WithdrawalLocked");
    }
  });

  it("should cancel withdrawal", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    await program.methods
      .cancelWithdrawal(1) // token_id = 1 (primary token)
      .accounts({
        owner: user1.publicKey,
      } as any)
      .signers([user1])
      .rpc();

    const participant = await program.account.participantAccount.fetch(
      participantPda
    );
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);
    expect(primaryTokenBalance.availableBalance.toNumber()).to.be.greaterThan(0);
  });

  it("should request withdrawal and execute after timelock", async () => {
    const participantPda = findParticipantPda(user1.publicKey);
    const vaultTokenAccount = findVaultTokenAccountPda(1);
    const withdrawAmount = 10_000_000; // 10 primary-token units

    await program.methods
      .requestWithdrawal(1, new anchor.BN(withdrawAmount), user1TokenAccount) // token_id = 1
      .accounts({
        owner: user1.publicKey,
        participantAccount: participantPda,
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    // Wait for timelock (2s on devnet)
    await sleep(3500);

    const user1BalanceBefore = (
      await getAccount(provider.connection, user1TokenAccount)
    ).amount;
    const feeRecipientBefore = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultBefore = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    await program.methods
      .executeWithdrawalTimelocked(1) // token_id = 1 (primary token)
      .accounts({
        participantAccount: participantPda,
        withdrawalDestination: user1TokenAccount,
        feeRecipientTokenAccount: feeRecipientTokenAccount,
      } as any)
      .rpc();

    const participant = await program.account.participantAccount.fetch(
      participantPda
    );
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);

    const user1BalanceAfter = (
      await getAccount(provider.connection, user1TokenAccount)
    ).amount;
    const feeRecipientAfter = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultAfter = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    const netReceived = Number(user1BalanceAfter - user1BalanceBefore);
    const feeReceived = Number(feeRecipientAfter - feeRecipientBefore);
    const vaultDecrease = Number(vaultBefore - vaultAfter);

    // Fee = max(minimum floor, percentage fee) = 50_000 for this withdrawal
    const expectedFee = 50_000;
    const expectedNet = withdrawAmount - expectedFee;
    expect(
      netReceived,
      "Net received must match withdrawAmount - fee"
    ).to.equal(expectedNet);
    expect(feeReceived, "Fee must respect the minimum floor").to.equal(expectedFee);
    expect(vaultDecrease).to.equal(
      netReceived + feeReceived,
      "Vault must decrease by net + fee"
    );
  });

  it("should execute a withdrawal for a second allowlisted token", async () => {
    const secondToken = await registerTestToken(SECOND_WITHDRAWAL_TOKEN_ID, "PYUSD");
    const participantPda = findParticipantPda(user1.publicKey);
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_WITHDRAWAL_TOKEN_ID);
    const destination = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      12_000_000
    );
    const withdrawAmount = 4_000_000;

    await program.methods
      .deposit(SECOND_WITHDRAWAL_TOKEN_ID, new anchor.BN(6_000_000))
      .accounts({
        owner: user1.publicKey,
        participantAccount: participantPda,
        ownerTokenAccount: destination,
        vaultTokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    await program.methods
      .requestWithdrawal(
        SECOND_WITHDRAWAL_TOKEN_ID,
        new anchor.BN(withdrawAmount),
        destination
      )
      .accounts({
        owner: user1.publicKey,
        participantAccount: participantPda,
        withdrawalDestination: destination,
      } as any)
      .signers([user1])
      .rpc();

    await sleep(3500);

    const destinationBefore = (await getAccount(provider.connection, destination)).amount;
    const feeRecipientBefore = (
      await getAccount(
        provider.connection,
        getFeeRecipientTokenAccount(SECOND_WITHDRAWAL_TOKEN_ID)
      )
    ).amount;
    const vaultBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;

    await program.methods
      .executeWithdrawalTimelocked(SECOND_WITHDRAWAL_TOKEN_ID)
      .accounts({
        participantAccount: participantPda,
        withdrawalDestination: destination,
        feeRecipientTokenAccount: getFeeRecipientTokenAccount(
          SECOND_WITHDRAWAL_TOKEN_ID
        ),
      } as any)
      .rpc();

    const participant = await program.account.participantAccount.fetch(
      participantPda
    );
    const secondTokenBalance = getTokenBalance(
      participant,
      SECOND_WITHDRAWAL_TOKEN_ID
    );
    const destinationAfter = (await getAccount(provider.connection, destination)).amount;
    const feeRecipientAfter = (
      await getAccount(
        provider.connection,
        getFeeRecipientTokenAccount(SECOND_WITHDRAWAL_TOKEN_ID)
      )
    ).amount;
    const vaultAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;

    expect(secondTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(secondTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);
    expect(Number(destinationAfter - destinationBefore)).to.equal(3_950_000);
    expect(Number(feeRecipientAfter - feeRecipientBefore)).to.equal(50_000);
    expect(Number(vaultBefore - vaultAfter)).to.equal(4_000_000);
  });
});
