import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.ANCHOR_WALLET ?? "./keys/deployer.json";

const PUMP_PROGRAM_ID = new anchor.web3.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new anchor.web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const MAYHEM_PROGRAM_ID = new anchor.web3.PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const MAYHEM_GLOBAL_PARAMS = new anchor.web3.PublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ");
const MAYHEM_SOL_VAULT = new anchor.web3.PublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s");
const PUMP_FEE_PROGRAM_ID = new anchor.web3.PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const PUMP_FEE_CONFIG_AUTHORITY = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
  137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")));
const payer = anchor.web3.Keypair.fromSecretKey(secret);
const wallet = new anchor.Wallet(payer);
const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

function findPda(seeds, programId) {
  return anchor.web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function encodeBuyExactSolInData(amountLamports, minOut) {
  const discriminator = Buffer.from("38fc74089edfcd5f", "hex");
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(amountLamports));
  const min = Buffer.alloc(8);
  min.writeBigUInt64LE(BigInt(minOut));
  const trackVolume = Buffer.from([1]);
  return Buffer.concat([discriminator, amount, min, trackVolume]);
}

async function loadPumpProgram() {
  const response = await fetch(
    "https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json"
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pump IDL: ${response.status}`);
  }
  const idl = await response.json();
  return new anchor.Program(idl, provider);
}

async function loadPumpIdl() {
  const response = await fetch(
    "https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json"
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pump IDL: ${response.status}`);
  }
  return response.json();
}

async function sendVersionedTxWithLookup(instructions, signers) {
  const currentSlot = await connection.getSlot("confirmed");
  const recentSlot = Math.max(currentSlot - 1, 0);
  const [createLookupTableIx, lookupTableAddress] =
    anchor.web3.AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot,
    });

  const createTx = new anchor.web3.Transaction().add(createLookupTableIx);
  const createSig = await provider.sendAndConfirm(createTx, [payer]);
  console.log("create_lookup_table tx:", createSig);

  const addresses = Array.from(
    new Map(
      instructions
        .flatMap((ix) => [...ix.keys.map((key) => key.pubkey), ix.programId])
        .map((pubkey) => [pubkey.toBase58(), pubkey])
    ).values()
  );

  for (let i = 0; i < addresses.length; i += 20) {
    const extendIx = anchor.web3.AddressLookupTableProgram.extendLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addresses.slice(i, i + 20),
    });
    const extendTx = new anchor.web3.Transaction().add(extendIx);
    const extendSig = await provider.sendAndConfirm(extendTx, [payer]);
    console.log("extend_lookup_table tx:", extendSig);
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const lookup = await connection.getAddressLookupTable(lookupTableAddress, "confirmed");
  if (!lookup.value) {
    throw new Error("Failed to fetch lookup table");
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  const messageV0 = new anchor.web3.TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([lookup.value]);

  const tx = new anchor.web3.VersionedTransaction(messageV0);
  tx.sign(signers);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  return sig;
}

async function main() {
  console.log("wallet:", wallet.publicKey.toBase58());
  console.log("rpc:", RPC_URL);

  const idl = await loadPumpIdl();
  const pumpProgram = new anchor.Program(idl, provider);
  const mint = anchor.web3.Keypair.generate();

  const pumpFunMintAuthority = findPda([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
  const bondingCurve = findPda(
    [Buffer.from("bonding-curve"), mint.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint.publicKey,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const mayhemState = findPda(
    [Buffer.from("mayhem-state"), mint.publicKey.toBuffer()],
    MAYHEM_PROGRAM_ID
  );
  const mayhemTokenVault = getAssociatedTokenAddressSync(
    mint.publicKey,
    MAYHEM_SOL_VAULT,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const eventAuthority = findPda([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
  const userBaseTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const globalVolumeAccumulator = findPda(
    [Buffer.from("global_volume_accumulator")],
    PUMP_PROGRAM_ID
  );
  const userVolumeAccumulator = findPda(
    [Buffer.from("user_volume_accumulator"), wallet.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const feeConfig = findPda(
    [Buffer.from("fee_config"), PUMP_FEE_CONFIG_AUTHORITY],
    PUMP_FEE_PROGRAM_ID
  );
  const creatorVault = findPda(
    [Buffer.from("creator-vault"), wallet.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const bondingCurveV2 = findPda(
    [Buffer.from("bonding-curve-v2"), mint.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );

  const globalAccountInfo = await connection.getAccountInfo(PUMP_GLOBAL, "confirmed");
  if (!globalAccountInfo) {
    throw new Error("Pump global account not found");
  }
  const coder = new anchor.BorshAccountsCoder(idl);
  const globalState = coder.decode("Global", globalAccountInfo.data);
  const feeRecipient = new anchor.web3.PublicKey(globalState.fee_recipient);

  const createIx = await pumpProgram.methods
    .createV2(
      "MoonoDirectCreate",
      "MDC",
      "https://example.com/direct-create.json",
      wallet.publicKey,
      false,
      { none: {} }
    )
    .accounts({
      mint: mint.publicKey,
      mintAuthority: pumpFunMintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global: PUMP_GLOBAL,
      user: wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      mayhemProgramId: MAYHEM_PROGRAM_ID,
      globalParams: MAYHEM_GLOBAL_PARAMS,
      solVault: MAYHEM_SOL_VAULT,
      mayhemState,
      mayhemTokenVault,
      eventAuthority,
      program: PUMP_PROGRAM_ID,
    })
    .instruction();

  const buyIx = new anchor.web3.TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: bondingCurveV2, isSigner: false, isWritable: true },
    ],
    data: encodeBuyExactSolInData(10_000_000, 1),
  });

  const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    userBaseTokenAccount,
    wallet.publicKey,
    mint.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  const tx = await sendVersionedTxWithLookup(
    [
      anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
        units: 500_000,
      }),
      createIx,
      createUserAtaIx,
      buyIx,
    ],
    [payer, mint]
  );

  console.log("tx:", tx);
  console.log("mint:", mint.publicKey.toBase58());
  console.log("bondingCurve:", bondingCurve.toBase58());
  console.log("userBaseTokenAccount:", userBaseTokenAccount.toBase58());
}

main().catch((error) => {
  console.error("direct pump.fun create_v2 failed");
  console.error(error);
  process.exit(1);
});
