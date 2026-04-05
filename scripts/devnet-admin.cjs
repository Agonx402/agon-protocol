#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const anchor = require("@coral-xyz/anchor");
const { Program } = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount } = require("@solana/spl-token");

const GLOBAL_CONFIG_SEED = "global-config";
const TOKEN_REGISTRY_SEED = "token-registry";
const PARTICIPANT_SEED = "participant";
const VAULT_TOKEN_ACCOUNT_SEED = "vault-token-account";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }

  return { command, options };
}

function createWallet(payer) {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (transaction) => {
      if ("version" in transaction) {
        transaction.sign([payer]);
      } else {
        transaction.partialSign(payer);
      }
      return transaction;
    },
    signAllTransactions: async (transactions) =>
      Promise.all(
        transactions.map(async (transaction) => {
          if ("version" in transaction) {
            transaction.sign([payer]);
          } else {
            transaction.partialSign(payer);
          }
          return transaction;
        })
      ),
  };
}

function loadProvider() {
  const rpcEndpoint =
    process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", "devnet-deployer.json");

  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8"))
  );
  const payer = Keypair.fromSecretKey(secretKey);
  const wallet = createWallet(payer);
  const connection = new Connection(rpcEndpoint, "confirmed");

  return new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

function loadProgram(provider) {
  const idlPath = path.join(__dirname, "..", "target", "idl", "agon_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  return new Program(idl, provider);
}

function findGlobalConfigPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_CONFIG_SEED)],
    programId
  )[0];
}

function findTokenRegistryPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    programId
  )[0];
}

function findParticipantPda(programId, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PARTICIPANT_SEED), owner.toBytes()],
    programId
  )[0];
}

function findVaultTokenAccountPda(programId, tokenId) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_TOKEN_ACCOUNT_SEED),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    programId
  )[0];
}

function symbolBytes(symbol) {
  const bytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(bytes, 0, 0, 8);
  return [...bytes];
}

function decodeSymbol(symbol) {
  return Buffer.from(symbol).toString("ascii").replace(/\0+$/g, "");
}

async function ensureFeeRecipientTokenAccount(provider, mint, feeRecipientWallet) {
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    mint,
    feeRecipientWallet,
    false,
    "confirmed",
    {
      commitment: "confirmed",
    }
  );

  return tokenAccount.address;
}

async function buildDeploymentTokens(program, provider, feeRecipientWallet) {
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  const tokens = await Promise.all(
    registry.tokens.map(async (entry) => {
      const mint = new PublicKey(entry.mint.toString());
      const feeRecipientTokenAccount = await ensureFeeRecipientTokenAccount(
        provider,
        mint,
        feeRecipientWallet
      );

      return {
        id: entry.id,
        mint: mint.toString(),
        symbol: decodeSymbol(entry.symbol),
        decimals: entry.decimals,
        vault: findVaultTokenAccountPda(program.programId, entry.id).toString(),
        feeRecipientTokenAccount: feeRecipientTokenAccount.toString(),
      };
    })
  );

  return tokens.sort((left, right) => left.id - right.id);
}

async function writeDeploymentConfig(program, provider) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  const tokens = await buildDeploymentTokens(
    program,
    provider,
    new PublicKey(globalConfig.feeRecipient.toString())
  );

  const deploymentConfig = {
    programId: program.programId.toString(),
    network: "devnet",
    chainId: globalConfig.chainId,
    messageDomain: Buffer.from(globalConfig.messageDomain).toString("hex"),
    deployer: provider.wallet.publicKey.toString(),
    authority: globalConfig.authority.toString(),
    feeRecipient: globalConfig.feeRecipient.toString(),
    feeBps: globalConfig.feeBps,
    registrationFeeLamports: globalConfig.registrationFeeLamports.toNumber(),
    withdrawalTimelockSeconds: globalConfig.withdrawalTimelockSeconds.toNumber(),
    tokens,
    deployedAt: new Date().toISOString(),
  };

  const outputPath = path.join(process.cwd(), "config", "devnet-deployment.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(deploymentConfig, null, 2)}\n`);

  return deploymentConfig;
}

async function ensureToken(program, provider, tokenId, mintAddress, symbol) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  const existing = registry.tokens.find(
    (entry) =>
      entry.id === tokenId ||
      entry.mint.toString() === mintAddress
  );

  if (!existing) {
    await program.methods
      .registerToken(tokenId, symbolBytes(symbol))
      .accounts({
        tokenRegistry: tokenRegistryPda,
        vaultTokenAccount: findVaultTokenAccountPda(program.programId, tokenId),
        mint: new PublicKey(mintAddress),
        globalConfig: globalConfigPda,
        authority: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  } else {
    if (existing.id !== tokenId) {
      throw new Error(
        `Mint ${mintAddress} is already registered under token id ${existing.id}, not ${tokenId}`
      );
    }
    if (existing.mint.toString() !== mintAddress) {
      throw new Error(
        `Token id ${tokenId} is already registered to ${existing.mint.toString()}, not ${mintAddress}`
      );
    }
  }

  const deploymentConfig = await writeDeploymentConfig(program, provider);
  return deploymentConfig.tokens.find((entry) => entry.id === tokenId);
}

async function ensureParticipant(program, provider) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  const participantPda = findParticipantPda(
    program.programId,
    provider.wallet.publicKey
  );

  let participant;
  try {
    participant = await program.account.participantAccount.fetch(participantPda);
  } catch {
    await program.methods
      .initializeParticipant()
      .accounts({
        globalConfig: globalConfigPda,
        participantAccount: participantPda,
        feeRecipient: new PublicKey(globalConfig.feeRecipient.toString()),
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([provider.wallet.payer])
      .rpc();
    participant = await program.account.participantAccount.fetch(participantPda);
  }

  return {
    participantPda: participantPda.toString(),
    participantId: participant.participantId,
    owner: participant.owner.toString(),
    inboundChannelPolicy: participant.inboundChannelPolicy,
  };
}

async function setInboundPolicy(program, provider, policy) {
  const participantPda = findParticipantPda(
    program.programId,
    provider.wallet.publicKey
  );

  await program.methods
    .updateInboundChannelPolicy(policy)
    .accounts({
      participantAccount: participantPda,
      owner: provider.wallet.publicKey,
    })
    .rpc();

  const participant = await program.account.participantAccount.fetch(participantPda);
  return {
    participantPda: participantPda.toString(),
    participantId: participant.participantId,
    owner: participant.owner.toString(),
    inboundChannelPolicy: participant.inboundChannelPolicy,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const provider = loadProvider();
  anchor.setProvider(provider);
  const program = loadProgram(provider);

  if (command === "ensure-token") {
    const tokenId = Number(options.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      throw new Error("ensure-token requires --id <positive integer>");
    }
    if (!options.mint) {
      throw new Error("ensure-token requires --mint <mint-address>");
    }
    if (!options.symbol) {
      throw new Error("ensure-token requires --symbol <symbol>");
    }

    const token = await ensureToken(program, provider, tokenId, options.mint, options.symbol);
    console.log(JSON.stringify({ ok: true, token }, null, 2));
    return;
  }

  if (command === "ensure-participant") {
    const participant = await ensureParticipant(program, provider);
    console.log(JSON.stringify({ ok: true, participant }, null, 2));
    return;
  }

  if (command === "set-inbound-policy") {
    const policy = Number(options.policy);
    if (![0, 1, 2].includes(policy)) {
      throw new Error("set-inbound-policy requires --policy 0|1|2");
    }
    const participant = await setInboundPolicy(program, provider, policy);
    console.log(JSON.stringify({ ok: true, participant }, null, 2));
    return;
  }

  if (command === "refresh-config") {
    const config = await writeDeploymentConfig(program, provider);
    console.log(JSON.stringify({ ok: true, config }, null, 2));
    return;
  }

  throw new Error(
    "Usage: node scripts/devnet-admin.cjs <ensure-token|ensure-participant|set-inbound-policy|refresh-config> [--id 2 --mint <mint> --symbol AGON | --policy 0]"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
