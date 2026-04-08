import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  provider,
  deployer,
  feeRecipient,
  upgradeAuthority,
  expectProgramError,
  TEST_CHAIN_ID,
} from "./shared/setup";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

describe("Protocol Initialization", () => {
  // Note: Protocol initialization tests are skipped because the shared setup
  // already initializes the protocol. These tests would require a different
  // test setup that doesn't pre-initialize the protocol.

  it.skip("initialize: rejects InvalidFeeBps (too low)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            2,
            new anchor.BN(0),
            deployer.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: PublicKey.findProgramAddressSync(
              [program.programId.toBuffer()],
              BPF_LOADER_UPGRADEABLE_PROGRAM_ID
            )[0],
          } as any)
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it.skip("initialize: rejects InvalidFeeBps (too high)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            31,
            new anchor.BN(0),
            deployer.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: PublicKey.findProgramAddressSync(
              [program.programId.toBuffer()],
              BPF_LOADER_UPGRADEABLE_PROGRAM_ID
            )[0],
          } as any)
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it.skip("initialize: rejects InvalidFeeRecipient (zero address)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            30,
            new anchor.BN(0),
            deployer.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: PublicKey.default,
            program: program.programId,
            programData: PublicKey.findProgramAddressSync(
              [program.programId.toBuffer()],
              BPF_LOADER_UPGRADEABLE_PROGRAM_ID
            )[0],
          } as any)
          .rpc(),
      "InvalidFeeRecipient"
    );
  });

  it.skip("initialize: rejects InvalidRegistrationFee (out of range)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            30,
            new anchor.BN(500_000),
            deployer.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: PublicKey.findProgramAddressSync(
              [program.programId.toBuffer()],
              BPF_LOADER_UPGRADEABLE_PROGRAM_ID
            )[0],
          } as any)
          .rpc(),
      "InvalidRegistrationFee"
    );
  });

  it.skip("should initialize the protocol", async () => {
    const feeBps = 30; // 0.3%
    const registrationFeeLamports = 0; // No registration fee for now

    const tx = await program.methods
      .initialize(
        TEST_CHAIN_ID,
        feeBps,
        new anchor.BN(registrationFeeLamports),
        deployer.publicKey
      )
      .accounts({
        upgradeAuthority: upgradeAuthority.publicKey,
        feeRecipient: feeRecipient.publicKey,
        program: program.programId,
        programData: PublicKey.findProgramAddressSync(
          [program.programId.toBuffer()],
          BPF_LOADER_UPGRADEABLE_PROGRAM_ID
        )[0],
      } as any)
      .rpc();

    // Verify global config was created
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfig.authority.toString()).to.equal(
      upgradeAuthority.publicKey.toString()
    );
    expect(globalConfig.pendingAuthority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(globalConfig.feeRecipient.toString()).to.equal(
      feeRecipient.publicKey.toString()
    );
    expect(globalConfig.feeBps).to.equal(feeBps);
    expect(globalConfig.chainId).to.equal(TEST_CHAIN_ID);
    expect(globalConfig.withdrawalTimelockSeconds.toNumber()).to.equal(2);
    expect(globalConfig.registrationFeeLamports.toNumber()).to.equal(
      registrationFeeLamports
    );
    expect(globalConfig.nextParticipantId).to.equal(0);
  });

  it("should update config (authority only)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const newAuthority = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
    );
    const newFeeBps = 10; // 0.1%

    await program.methods
      .updateConfig(newAuthority.publicKey, null, newFeeBps, null)
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfig.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(globalConfig.pendingAuthority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(globalConfig.feeBps).to.equal(newFeeBps);
    expect(globalConfig.chainId).to.equal(TEST_CHAIN_ID);

    await expectProgramError(
      () =>
        program.methods
          .acceptConfigAuthority()
          .accounts({
            globalConfig: globalConfigPda,
            pendingAuthority: feeRecipient.publicKey,
          } as any)
          .signers([feeRecipient])
          .rpc(),
      "UnauthorizedPendingAuthority"
    );

    await program.methods
      .acceptConfigAuthority()
      .accounts({
        globalConfig: globalConfigPda,
        pendingAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    const acceptedConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(acceptedConfig.authority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(globalConfig.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(acceptedConfig.pendingAuthority.toString()).to.equal(
      PublicKey.default.toString()
    );

    // Restore deployer as authority for subsequent tests
    await program.methods
      .updateConfig(deployer.publicKey, null, 30, null)
      .accounts({
        authority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    await program.methods
      .acceptConfigAuthority()
      .accounts({
        globalConfig: globalConfigPda,
        pendingAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();
  });
});
