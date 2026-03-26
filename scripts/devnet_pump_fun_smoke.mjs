import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.ANCHOR_WALLET ?? "./keys/deployer.json";

const PROGRAM_ID = new anchor.web3.PublicKey("moonoL26kRC8S49yPuuopKhbNhvgf2h4Dva91noD8rN");
const PUMP_PROGRAM_ID = new anchor.web3.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FEE_PROGRAM_ID = new anchor.web3.PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const PUMP_GLOBAL = new anchor.web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const MAYHEM_PROGRAM_ID = new anchor.web3.PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const MAYHEM_GLOBAL_PARAMS = new anchor.web3.PublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ");
const MAYHEM_SOL_VAULT = new anchor.web3.PublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s");
const PUMP_FEE_RECIPIENT_CANDIDATES = [
  "68yFSZxzLWJXkxxRGydZ63C6mHx1NLEDWmwN9Lb5yySg",
  "6QgPshH1egekJ2TURfakiiApDdv98qfRuRe7RectX8xs",
  "78i5hpHxbtmosSJdfJ74WzwdUr3eKWg9RbCPpBeAF78t",
  "8RMFYhsVsfdGCuWPFLxMCbSpSesiofabDdNorGqFrBNe",
  "9GDepfBcjJMvNgmijXWVWa97Am7VZYCqXx7kJV44E9ij",
  "9ppkS5madL2uXozoEnMnZi5bKDq9jgdKkSavjWTS5NfW",
  "DDMCfwbcaNYTeMk1ca8tr8BQKFaUfFCWFwBJq8JcnyCw",
  "DRDBsRMst21CJUhwD16pncgiXnBrFaRAPvA2G6SUQceE",
  "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
  "4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6",
  "8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR",
  "4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH",
  "8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6",
  "Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk",
  "463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq",
  "6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA",
].map((value) => new anchor.web3.PublicKey(value));
const PUMP_FEE_CONFIG_AUTHORITY = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
  137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

const idl = JSON.parse(fs.readFileSync("./target/idl/moono.json", "utf8"));
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")));
const payer = anchor.web3.Keypair.fromSecretKey(secret);
const wallet = new anchor.Wallet(payer);
const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const PAGE_SIZE = 32;
const SMOKE_LABEL = process.env.MOONO_SMOKE_LABEL ?? "devnet-pump-fun-smoke";
const EXECUTE_LOAN_QUOTE_SPEND_AMOUNT = Number(
  process.env.MOONO_EXECUTE_LOAN_QUOTE_SPEND_AMOUNT ?? 10_000_000
);
const EXECUTE_EXTRA_USER_QUOTE_SPEND_AMOUNT = Number(
  process.env.MOONO_EXECUTE_EXTRA_USER_QUOTE_SPEND_AMOUNT ?? 0
);
const EXECUTE_COLLATERAL_MIN_BASE_OUT = Number(
  process.env.MOONO_EXECUTE_COLLATERAL_MIN_BASE_OUT ?? 1
);
const EXECUTE_IMMEDIATE_USER_MIN_BASE_OUT = Number(
  process.env.MOONO_EXECUTE_IMMEDIATE_USER_MIN_BASE_OUT ?? 0
);

function bn(value) {
  return new BN(value.toString());
}

function makeRoutePlanHash(label) {
  const bytes = Buffer.alloc(32);
  Buffer.from(label).copy(bytes, 0, 0, Math.min(label.length, 32));
  return Array.from(bytes);
}

function makeUniqueLoanId() {
  return new BN(BigInt(Date.now()).toString());
}

function findPda(seeds, programId = PROGRAM_ID) {
  return anchor.web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
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
        .flatMap((ix) => [
          ...ix.keys.map((key) => key.pubkey),
          ix.programId,
        ])
        .map((pubkey) => [pubkey.toBase58(), pubkey])
    ).values()
  );

  for (let i = 0; i < addresses.length; i += 20) {
    const extendIx = anchor.web3.AddressLookupTableProgram.extendLookupTable({
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addresses.slice(i, i + 20),
    });
    const extendTx = new anchor.web3.Transaction().add(extendIx);
    const extendSig = await provider.sendAndConfirm(extendTx, [payer]);
    console.log("extend_lookup_table tx:", extendSig);
  }

  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const lookupTableAccount = (
    await connection.getAddressLookupTable(lookupTableAddress)
  ).value;
  if (!lookupTableAccount) {
    throw new Error("Lookup table not found on devnet");
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new anchor.web3.TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([lookupTableAccount]);

  const tx = new anchor.web3.VersionedTransaction(message);
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

async function ensureProtocolInitialized() {
  const protocol = findPda([Buffer.from("protocol")]);
  const existing = await connection.getAccountInfo(protocol);
  if (!existing) {
    const tx = await program.methods
      .initializeProtocol()
      .accounts({
        protocol,
        authority: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_protocol tx:", tx);
  }
  return protocol;
}

async function ensureAssetPool(protocol, mint) {
  const assetPool = findPda([Buffer.from("asset_pool"), mint.toBuffer()]);
  const vaultAuthority = findPda([Buffer.from("vault_authority"), assetPool.toBuffer()]);
  const vault = findPda([Buffer.from("vault"), assetPool.toBuffer()]);
  const protocolQuoteTreasuryAuthority = findPda([
    Buffer.from("quote_treasury_auth"),
    assetPool.toBuffer(),
  ]);
  const protocolQuoteTreasuryVault = findPda([
    Buffer.from("quote_treasury_vault"),
    assetPool.toBuffer(),
  ]);

  const existing = await connection.getAccountInfo(assetPool);
  if (!existing) {
    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol,
        assetPool,
        mint,
        vaultAuthority,
        vault,
        protocolQuoteTreasuryAuthority,
        protocolQuoteTreasuryVault,
        authority: wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_asset_pool tx:", tx);
  }

  const assetPoolAccount = await program.account.assetPool.fetch(assetPool);
  if (!assetPoolAccount.isEnabled || !assetPoolAccount.allowDeposits || !assetPoolAccount.allowBorrows) {
    const tx = await program.methods
      .setAssetPoolFlags(true, true, true)
      .accounts({
        protocol,
        assetPool,
        authority: wallet.publicKey,
      })
      .rpc();
    console.log("set_asset_pool_flags tx:", tx);
  }

  return {
    assetPool,
    vaultAuthority,
    vault,
    protocolQuoteTreasuryAuthority,
    protocolQuoteTreasuryVault,
  };
}

async function ensureExecutionStrategyConfig(protocol) {
  const mode = 1;
  const strategyConfig = findPda([Buffer.from("strategy_config"), Buffer.from([mode])]);
  const existing = await connection.getAccountInfo(strategyConfig);
  if (!existing) {
    const tx = await program.methods
      .initializeExecutionStrategyConfig(
        mode,
        1000,
        1500,
        bn(500_000_000),
        bn(50_000_000)
      )
      .accounts({
        protocol,
        strategyConfig,
        authority: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_execution_strategy_config tx:", tx);
  } else {
    const tx = await program.methods
      .setExecutionStrategyConfig(true, 1000, 1500, bn(500_000_000), bn(50_000_000))
      .accounts({
        protocol,
        strategyConfig,
        authority: wallet.publicKey,
      })
      .rpc();
    console.log("set_execution_strategy_config tx:", tx);
  }
  return strategyConfig;
}

async function ensureTickPage(protocol, assetPool, pageIndex) {
  const tickPage = findPda([
    Buffer.from("tick_page"),
    assetPool.toBuffer(),
    new BN(pageIndex).toArrayLike(Buffer, "le", 4),
  ]);
  const existing = await connection.getAccountInfo(tickPage);
  if (!existing) {
    const tx = await program.methods
      .initializeTickPage(pageIndex)
      .accounts({
        protocol,
        assetPool,
        tickPage,
        authority: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_tick_page tx:", tx);
  }
  return tickPage;
}

async function ensureWsol(amountLamports) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    wallet.publicKey
  );

  const before = await getAccount(connection, ata.address);
  const current = Number(before.amount);
  if (current < amountLamports) {
    const topUp = amountLamports - current;
    const tx = await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: ata.address,
          lamports: topUp,
        }),
        createSyncNativeInstruction(ata.address)
      ),
      [payer]
    );
    console.log("wrap_sol tx:", tx);
  }

  return ata.address;
}

async function main() {
  console.log("wallet:", wallet.publicKey.toBase58());
  console.log("rpc:", RPC_URL);

  const protocol = await ensureProtocolInitialized();
  const {
    assetPool,
    vaultAuthority,
    vault,
    protocolQuoteTreasuryAuthority,
    protocolQuoteTreasuryVault,
  } = await ensureAssetPool(protocol, NATIVE_MINT);
  const strategyConfig = await ensureExecutionStrategyConfig(protocol);

  const depositAmount = 600_000_000;
  const requestedQuoteAmount = bn(400_000_000);
  const fundedQuoteAmount = bn(300_000_000);
  const extraUserQuoteAmount = bn(50_000_000);
  const totalUpfrontInterestPaid = bn(30_000_000);
  const totalProtocolFeePaid = bn(10_000_000);
  const totalPlatformCostPaid = bn(10_000_000);
  const termSec = bn(7 * 24 * 60 * 60);
  const percentBuffer = Math.floor(
    (Number(fundedQuoteAmount) * 1000) / 10_000
  );
  const requiredQuoteBufferAmount = Math.max(percentBuffer, 500_000_000) + 50_000_000;
  const requiredWalletLamports =
    depositAmount +
    requiredQuoteBufferAmount +
    Number(totalUpfrontInterestPaid) +
    Number(totalProtocolFeePaid) +
    Number(totalPlatformCostPaid) +
    Number(extraUserQuoteAmount);

  console.log("required quote buffer amount:", requiredQuoteBufferAmount.toString());
  console.log("required wallet lamports:", requiredWalletLamports.toString());

  const userQuoteAta = await ensureWsol(requiredWalletLamports);

  const tick = 21;
  const pageIndex = Math.floor(tick / PAGE_SIZE);
  const tickPage = await ensureTickPage(protocol, assetPool, pageIndex);
  const lpPosition = findPda([
    Buffer.from("lp_position"),
    wallet.publicKey.toBuffer(),
    assetPool.toBuffer(),
    new BN(tick).toArrayLike(Buffer, "le", 4),
  ]);

  const depositTx = await program.methods
      .depositToTick(tick, bn(depositAmount))
    .accounts({
      protocol,
      assetPool,
      owner: wallet.publicKey,
      mint: NATIVE_MINT,
      userTokenAccount: userQuoteAta,
      vault,
      lpPosition,
      tickPage,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  console.log("deposit_to_tick tx:", depositTx);

  const loanId = makeUniqueLoanId();
  const loanPosition = findPda([
    Buffer.from("loan_position"),
    wallet.publicKey.toBuffer(),
    loanId.toArrayLike(Buffer, "le", 8),
  ]);
  const loanVaultAuthority = findPda([
    Buffer.from("loan_vault_authority"),
    loanPosition.toBuffer(),
  ]);
  const loanQuoteVault = findPda([
    Buffer.from("loan_quote_vault"),
    loanPosition.toBuffer(),
  ]);
  const loanQuoteBufferVault = findPda([
    Buffer.from("loan_quote_buffer_vault"),
    loanPosition.toBuffer(),
  ]);

  const openLoanTx = await program.methods
    .openLoan(
      loanId,
      makeRoutePlanHash(SMOKE_LABEL),
      1,
      requestedQuoteAmount,
      fundedQuoteAmount,
      extraUserQuoteAmount,
      termSec,
      totalUpfrontInterestPaid,
      totalProtocolFeePaid,
      totalPlatformCostPaid
    )
    .accounts({
      protocol,
      quoteAssetPool: assetPool,
      strategyConfig,
      owner: wallet.publicKey,
      quoteMint: NATIVE_MINT,
      userQuoteTokenAccount: userQuoteAta,
      loanPosition,
      loanVaultAuthority,
      loanQuoteVault,
      loanQuoteBufferVault,
      protocolQuoteTreasuryAuthority,
      protocolQuoteTreasuryVault,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  console.log("open_loan tx:", openLoanTx);

  const borrowSlicePosition = findPda([
    Buffer.from("borrow_position"),
    loanPosition.toBuffer(),
    new BN(tick).toArrayLike(Buffer, "le", 4),
  ]);

  const initBorrowSliceTx = await program.methods
    .initializeBorrowSlicePosition(loanId, tick)
    .accounts({
      protocol,
      quoteAssetPool: assetPool,
      loanPosition,
      owner: wallet.publicKey,
      borrowSlicePosition,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  console.log("initialize_borrow_slice_position tx:", initBorrowSliceTx);

  const fundTx = await program.methods
    .fundLoanFromTicks([
      {
        tick,
        principalAmount: fundedQuoteAmount,
        upfrontInterestAmount: totalUpfrontInterestPaid,
        protocolFeeAmount: totalProtocolFeePaid,
      },
    ])
    .accounts({
      protocol,
      quoteAssetPool: assetPool,
      owner: wallet.publicKey,
      quoteMint: NATIVE_MINT,
      vaultAuthority,
      vault,
      loanPosition,
      loanQuoteVault,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: tickPage, isSigner: false, isWritable: true },
      { pubkey: borrowSlicePosition, isSigner: false, isWritable: true },
    ])
    .rpc();
  console.log("fund_loan_from_ticks tx:", fundTx);

  const baseMint = anchor.web3.Keypair.generate();
  const loanExecutionWallet = findPda([
    Buffer.from("loan_execution_wallet"),
    loanPosition.toBuffer(),
  ]);
  const loanCollateralVault = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    loanExecutionWallet,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const userBaseTokenAccount = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const userBaseBeforeInfo = await connection.getAccountInfo(userBaseTokenAccount);
  const pumpFunLoanTemporaryWsolVault = findPda([
    Buffer.from("temp_wsol_vault"),
    loanPosition.toBuffer(),
    Buffer.from("loan"),
  ]);

  const pumpFunMintAuthority = findPda([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
  const pumpFunBondingCurve = findPda(
    [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const pumpFunAssociatedBondingCurve = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    pumpFunBondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const pumpFunEventAuthority = findPda([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
  const pumpFunMayhemState = findPda(
    [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
    MAYHEM_PROGRAM_ID
  );
  const pumpFunMayhemTokenVault = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    MAYHEM_SOL_VAULT,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const pumpFunCreatorVault = findPda(
    [Buffer.from("creator-vault"), wallet.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const pumpFunBondingCurveV2 = findPda(
    [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const pumpFunGlobalVolumeAccumulator = findPda(
    [Buffer.from("global_volume_accumulator")],
    PUMP_PROGRAM_ID
  );
  const pumpFunExecutionWalletVolumeAccumulator = findPda(
    [Buffer.from("user_volume_accumulator"), loanExecutionWallet.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const pumpFunOwnerVolumeAccumulator = findPda(
    [Buffer.from("user_volume_accumulator"), wallet.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const pumpFunFeeConfig = findPda(
    [Buffer.from("fee_config"), PUMP_FEE_CONFIG_AUTHORITY],
    PUMP_FEE_PROGRAM_ID
  );
  const userQuoteBeforeExecute = await getAccount(connection, userQuoteAta);
  console.log("user quote balance before execute:", userQuoteBeforeExecute.amount.toString());

  let executeTx;
  let executeError;
  for (const pumpFunFeeRecipient of PUMP_FEE_RECIPIENT_CANDIDATES) {
    try {
      console.log("trying fee recipient:", pumpFunFeeRecipient.toBase58());
      const executeIx = await program.methods
        .executeLaunchPumpFun(
          true,
          "MoonoDevnetSmoke",
          "MDS",
          "https://example.com/devnet-smoke.json",
          bn(EXECUTE_LOAN_QUOTE_SPEND_AMOUNT),
          bn(EXECUTE_EXTRA_USER_QUOTE_SPEND_AMOUNT),
          bn(EXECUTE_COLLATERAL_MIN_BASE_OUT),
          bn(EXECUTE_IMMEDIATE_USER_MIN_BASE_OUT)
        )
        .accounts({
          protocol,
          quoteAssetPool: assetPool,
          owner: wallet.publicKey,
          quoteMint: NATIVE_MINT,
          baseMint: baseMint.publicKey,
          loanPosition,
          loanVaultAuthority,
          loanExecutionWallet,
          loanQuoteVault,
          userExtraQuoteTokenAccount: userQuoteAta,
          pumpFunProgram: PUMP_PROGRAM_ID,
          pumpFunGlobal: PUMP_GLOBAL,
          pumpFunBondingCurve,
          pumpFunAssociatedBondingCurve,
          pumpFunMayhemProgram: MAYHEM_PROGRAM_ID,
          pumpFunGlobalParams: MAYHEM_GLOBAL_PARAMS,
          pumpFunSolVault: MAYHEM_SOL_VAULT,
          pumpFunMayhemState,
          pumpFunMayhemTokenVault,
          pumpFunLoanTemporaryWsolVault,
          pumpFunMintAuthority,
          pumpFunEventAuthority,
          pumpFunFeeRecipient: pumpFunFeeRecipient,
          pumpFunCreatorVault,
          loanCollateralVault,
          userBaseTokenAccount,
          quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: pumpFunGlobalVolumeAccumulator, isSigner: false, isWritable: false },
          {
            pubkey: pumpFunExecutionWalletVolumeAccumulator,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: pumpFunOwnerVolumeAccumulator, isSigner: false, isWritable: true },
          { pubkey: pumpFunFeeConfig, isSigner: false, isWritable: false },
          { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: pumpFunBondingCurveV2, isSigner: false, isWritable: true },
        ])
        .instruction();
      executeTx = await sendVersionedTxWithLookup(
        [
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 500_000,
          }),
          executeIx,
        ],
        [payer, baseMint]
      );
      console.log("execute_launch_pump_fun tx:", executeTx);
      executeError = undefined;
      break;
    } catch (error) {
      executeError = error;
      const message = String(error?.message ?? error);
      if (!message.includes("NotAuthorized")) {
        throw error;
      }
    }
  }
  if (!executeTx) {
    throw executeError ?? new Error("executeLaunchPumpFun failed for all fee recipients");
  }

  const loan = await program.account.loanPosition.fetch(loanPosition);
  const collateralAccount = await getAccount(
    connection,
    loanCollateralVault,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  const userBaseAccount = await getAccount(
    connection,
    userBaseTokenAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  console.log("loan status:", loan.status);
  console.log("base mint:", baseMint.publicKey.toBase58());
  console.log("collateral vault:", loan.collateralVault.toBase58());
  console.log("collateral base amount:", collateralAccount.amount.toString());
  console.log("user base token account:", userBaseTokenAccount.toBase58());
  console.log("user base amount:", userBaseAccount.amount.toString());
  console.log("executed loan quote amount:", loan.executedLoanQuoteAmount.toString());
  console.log(
    "executed extra user quote amount:",
    loan.executedExtraUserQuoteAmount.toString()
  );
  console.log("immediate user base amount:", loan.immediateUserBaseAmount.toString());

  if (EXECUTE_EXTRA_USER_QUOTE_SPEND_AMOUNT > 0) {
    if (!userBaseBeforeInfo && userBaseAccount.amount === 0n) {
      throw new Error("Expected user base token account to be created and funded");
    }
    if (userBaseAccount.amount === 0n) {
      throw new Error("Expected user base amount to be greater than zero");
    }
    if (loan.immediateUserBaseAmount === 0n) {
      throw new Error("Expected immediate user base amount to be greater than zero");
    }
  }
}

main().catch((error) => {
  console.error("devnet pump.fun smoke failed");
  console.error(error);
  process.exit(1);
});
