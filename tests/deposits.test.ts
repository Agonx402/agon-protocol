import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  program,
  provider,
  user1,
  user2,
  user3,
  user4,
  user1TokenAccount,
  findParticipantPda,
  findVaultTokenAccountPda,
  registerTestToken,
  createFundedTokenAccount,
} from "./shared/setup";

const SECOND_DEPOSIT_TOKEN_ID = 11;

describe("Deposit", () => {
  it("should deposit the primary test token into participant balance", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-token-account"), new anchor.BN(1).toArrayLike(Buffer, "le", 2)],
      program.programId
    );

    const depositAmount = 50000000; // 50 primary-token units (6 decimals)

    // Check balances before
    const userTokenAccountBefore = await getAccount(provider.connection, user1TokenAccount);
    const vaultTokenAccountBefore = await getAccount(provider.connection, vaultTokenAccount);
    const participantBefore = await program.account.participantAccount.fetch(participantPda);

    const tx = await program.methods
      .deposit(1, new anchor.BN(depositAmount)) // token_id = 1 (primary token)
      .accounts({
        owner: user1.publicKey,
        ownerTokenAccount: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    // Check balances after
    const userTokenAccountAfter = await getAccount(provider.connection, user1TokenAccount);
    const vaultTokenAccountAfter = await getAccount(provider.connection, vaultTokenAccount);
    const participantAfter = await program.account.participantAccount.fetch(participantPda);

    // Verify token transfer
    expect(userTokenAccountAfter.amount - userTokenAccountBefore.amount).to.equal(-BigInt(depositAmount));
    expect(vaultTokenAccountAfter.amount - vaultTokenAccountBefore.amount).to.equal(BigInt(depositAmount));
    // Conservation: total tokens unchanged
    expect(userTokenAccountAfter.amount + vaultTokenAccountAfter.amount).to.equal(
      userTokenAccountBefore.amount + vaultTokenAccountBefore.amount
    );

    // Verify participant balance update (token-specific)
    const tokenBalanceBefore = participantBefore.tokenBalances.find(b => b.tokenId === 1)?.availableBalance.toNumber() || 0;
    const tokenBalanceAfter = participantAfter.tokenBalances.find(b => b.tokenId === 1)?.availableBalance.toNumber() || 0;
    expect(tokenBalanceAfter - tokenBalanceBefore).to.equal(depositAmount);
  });

  it("should deposit_for multiple agents at once", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-token-account"), new anchor.BN(1).toArrayLike(Buffer, "le", 2)],
      program.programId
    );

    const [participant1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user1.publicKey.toBytes()],
      program.programId
    );
    const [participant2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user2.publicKey.toBytes()],
      program.programId
    );
    const [participant3Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user3.publicKey.toBytes()],
      program.programId
    );
    const [participant4Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), user4.publicKey.toBytes()],
      program.programId
    );

    const amounts = [10000000, 20000000, 30000000, 5000000]; // 10, 20, 30, 5 token units
    const total = 65000000;

    const participant1Before = await program.account.participantAccount.fetch(participant1Pda);
    const participant2Before = await program.account.participantAccount.fetch(participant2Pda);
    const participant3Before = await program.account.participantAccount.fetch(participant3Pda);
    const participant4Before = await program.account.participantAccount.fetch(participant4Pda);

    await program.methods
      .depositFor(1, amounts.map((a) => new anchor.BN(a))) // token_id = 1 (primary token)
      .accounts({
        funderTokenAccount: user1TokenAccount,
        funder: user1.publicKey,
      } as any)
      .remainingAccounts([
        { pubkey: participant1Pda, isSigner: false, isWritable: true },
        { pubkey: participant2Pda, isSigner: false, isWritable: true },
        { pubkey: participant3Pda, isSigner: false, isWritable: true },
        { pubkey: participant4Pda, isSigner: false, isWritable: true },
      ])
      .signers([user1])
      .rpc();

    const participant1After = await program.account.participantAccount.fetch(participant1Pda);
    const participant2After = await program.account.participantAccount.fetch(participant2Pda);
    const participant3After = await program.account.participantAccount.fetch(participant3Pda);
    const participant4After = await program.account.participantAccount.fetch(participant4Pda);

    const getTokenBalance = (participant: any, tokenId: number) =>
      participant.tokenBalances.find((b: any) => b.tokenId === tokenId)?.availableBalance || 0;

    expect(getTokenBalance(participant1After, 1) - getTokenBalance(participant1Before, 1)).to.equal(amounts[0]);
    expect(getTokenBalance(participant2After, 1) - getTokenBalance(participant2Before, 1)).to.equal(amounts[1]);
    expect(getTokenBalance(participant3After, 1) - getTokenBalance(participant3Before, 1)).to.equal(amounts[2]);
    expect(getTokenBalance(participant4After, 1) - getTokenBalance(participant4Before, 1)).to.equal(amounts[3]);
  });

  it("should deposit a second allowlisted token into participant balance", async () => {
    const secondToken = await registerTestToken(SECOND_DEPOSIT_TOKEN_ID, "EURC");
    const participantPda = findParticipantPda(user1.publicKey);
    const secondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      25_000_000
    );
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_DEPOSIT_TOKEN_ID);
    const depositAmount = 7_000_000;

    const userTokenAccountBefore = await getAccount(
      provider.connection,
      secondTokenAccount
    );
    const vaultTokenAccountBefore = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const participantBefore = await program.account.participantAccount.fetch(
      participantPda
    );

    await program.methods
      .deposit(SECOND_DEPOSIT_TOKEN_ID, new anchor.BN(depositAmount))
      .accounts({
        owner: user1.publicKey,
        participantAccount: participantPda,
        ownerTokenAccount: secondTokenAccount,
        vaultTokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    const userTokenAccountAfter = await getAccount(
      provider.connection,
      secondTokenAccount
    );
    const vaultTokenAccountAfter = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const participantAfter = await program.account.participantAccount.fetch(
      participantPda
    );

    expect(userTokenAccountAfter.amount - userTokenAccountBefore.amount).to.equal(
      -BigInt(depositAmount)
    );
    expect(
      vaultTokenAccountAfter.amount - vaultTokenAccountBefore.amount
    ).to.equal(BigInt(depositAmount));

    const tokenBalanceBefore =
      participantBefore.tokenBalances.find(
        (b: any) => b.tokenId === SECOND_DEPOSIT_TOKEN_ID
      )?.availableBalance.toNumber() || 0;
    const tokenBalanceAfter =
      participantAfter.tokenBalances.find(
        (b: any) => b.tokenId === SECOND_DEPOSIT_TOKEN_ID
      )?.availableBalance.toNumber() || 0;

    expect(tokenBalanceAfter - tokenBalanceBefore).to.equal(depositAmount);
  });
});
