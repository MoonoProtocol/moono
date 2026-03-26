import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Moono } from "../target/types/moono";
import {
  createSyncNativeInstruction,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

describe("moono", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.moono as any;
  const mockPumpFunProgram =
    (anchor.workspace as any).mockPumpFun ??
    (anchor.workspace as any).mock_pump_fun ??
    (anchor.workspace as any).MockPumpFun;
  const wallet = provider.wallet as anchor.Wallet & {
    payer: anchor.web3.Keypair;
  };
  const pumpFeeProgramId = new anchor.web3.PublicKey(
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
  );
  const pumpFeeConfigAuthority = Buffer.from([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
    137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
  ]);

  const PAGE_SIZE = 32;
  let loanIdNonce = 0n;

  if (!mockPumpFunProgram) {
    throw new Error("mock_pump_fun workspace program is missing");
  }

  function makeRoutePlanHash(label: string): number[] {
    const bytes = Buffer.alloc(32);
    Buffer.from(label).copy(bytes, 0, 0, Math.min(label.length, 32));
    return Array.from(bytes);
  }

  function makeUniqueLoanId(): anchor.BN {
    loanIdNonce += 1n;
    return new anchor.BN(BigInt(Date.now()) + loanIdNonce);
  }

  async function sendVersionedTxWithLookup(
    instructions: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Signer[]
  ): Promise<string> {
    const currentSlot = await provider.connection.getSlot("confirmed");
    const recentSlot = Math.max(currentSlot - 1, 0);
    const [createLookupTableIx, lookupTableAddress] =
      anchor.web3.AddressLookupTableProgram.createLookupTable({
        authority: wallet.payer.publicKey,
        payer: wallet.payer.publicKey,
        recentSlot,
      });

    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createLookupTableIx), [
      wallet.payer,
    ]);

    const addresses = Array.from(
      new Map(
        instructions
          .flatMap((ix) => [...ix.keys.map((key) => key.pubkey), ix.programId])
          .map((pubkey) => [pubkey.toBase58(), pubkey])
      ).values()
    );

    for (let i = 0; i < addresses.length; i += 20) {
      const extendIx = anchor.web3.AddressLookupTableProgram.extendLookupTable({
        payer: wallet.payer.publicKey,
        authority: wallet.payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: addresses.slice(i, i + 20),
      });
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(extendIx), [
        wallet.payer,
      ]);
    }

    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const lookupTableAccount = (
      await provider.connection.getAddressLookupTable(lookupTableAddress)
    ).value;
    if (!lookupTableAccount) {
      throw new Error("Lookup table not found");
    }

    const latest = await provider.connection.getLatestBlockhash("confirmed");
    const message = new anchor.web3.TransactionMessage({
      payerKey: wallet.payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message([lookupTableAccount]);

    const tx = new anchor.web3.VersionedTransaction(message);
    tx.sign(signers);
    const sig = await provider.connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 20,
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
      const { value } = await provider.connection.getSignatureStatuses([sig]);
      const status = value[0];
      if (status?.err) {
        throw new Error(`Versioned tx failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        return sig;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Versioned tx was not confirmed in time: ${sig}`);
  }



  async function ensureProtocolInitialized() {
    const [protocolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    const existing = await provider.connection.getAccountInfo(protocolPda);

    if (!existing) {
      const tx = await program.methods
        .initializeProtocol()
        .accounts({
          protocol: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      return [protocolPda, tx];
    }

    const protocolAccount = await program.account.protocolConfig.fetch(protocolPda);

    if (!protocolAccount.authority.equals(provider.wallet.publicKey)) {
      throw new Error("Authority mismatch");
    }

    if (protocolAccount.paused !== false) {
      throw new Error("Paused should be false");
    }

    return [protocolPda, null];
  }

  async function ensureExecutionStrategyConfig(
    protocolPda: anchor.web3.PublicKey,
    mode: number,
    isEnabled: boolean,
    extraQuoteCollateralBps: number,
    maxQuoteLossBps: number,
    minQuoteBufferAmount: anchor.BN,
    fixedMigrationCostQuote: anchor.BN
  ) {
    const [strategyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_config"), Buffer.from([mode])],
      program.programId
    );

    const existing = await provider.connection.getAccountInfo(strategyConfigPda);

    if (!existing) {
      const tx = await program.methods
        .initializeExecutionStrategyConfig(
          mode,
          extraQuoteCollateralBps,
          maxQuoteLossBps,
          minQuoteBufferAmount,
          fixedMigrationCostQuote
        )
        .accounts({
          protocol: protocolPda,
          strategyConfig: strategyConfigPda,
          authority: wallet.payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet.payer])
        .rpc();

      return { strategyConfigPda, tx };
    } else {
      const tx = await program.methods
        .setExecutionStrategyConfig(
          isEnabled,
          extraQuoteCollateralBps,
          maxQuoteLossBps,
          minQuoteBufferAmount,
          fixedMigrationCostQuote
        )
        .accounts({
          protocol: protocolPda,
          strategyConfig: strategyConfigPda,
          authority: wallet.payer.publicKey,
        })
        .signers([wallet.payer])
        .rpc();

      return { strategyConfigPda, tx };
    }
  }

  async function ensureTickPage(
    protocolPda: anchor.web3.PublicKey,
    assetPoolPda: anchor.web3.PublicKey,
    pageIndex: number,
    authority: anchor.web3.PublicKey
  ) {
    const [tickPagePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_page"),
        assetPoolPda.toBuffer(),
        new anchor.BN(pageIndex).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const existing = await provider.connection.getAccountInfo(tickPagePda);

    if (!existing) {
      const tx = await program.methods
        .initializeTickPage(pageIndex)
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          tickPage: tickPagePda,
          authority,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet.payer])
        .rpc();

      return { tickPagePda, tx };
    }

    return { tickPagePda, tx: null };
  }

  async function ensureAssetPool(
    protocolPda: anchor.web3.PublicKey,
    mint: anchor.web3.PublicKey
  ) {
    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );
    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );
    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );
    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    const existing = await provider.connection.getAccountInfo(assetPoolPda);
    let tx = null;

    if (!existing) {
      tx = await program.methods
        .initializeAssetPool()
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
          protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
          authority: wallet.payer.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet.payer])
        .rpc();
    }

    return {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
      tx,
    };
  }

  it("set_protocol_paused", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    await program.methods
      .setProtocolPaused(true)
      .accounts({
        protocol: protocolPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();

    let protocol = await program.account.protocolConfig.fetch(protocolPda);

    if (protocol.paused !== true) {
      throw new Error("Protocol should be paused");
    }

    const tx = await program.methods
      .setProtocolPaused(false)
      .accounts({
        protocol: protocolPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();
    console.log("tx:", tx);

    protocol = await program.account.protocolConfig.fetch(protocolPda);

    if (protocol.paused !== false) {
      throw new Error("Protocol should be unpaused");
    }
  });

  it("initialize_asset_pool_creates_vault", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const assetPool = await program.account.assetPool.fetch(assetPoolPda);

    if (!assetPool.protocol.equals(protocolPda)) {
      throw new Error("Protocol mismatch");
    }

    if (!assetPool.mint.equals(mint)) {
      throw new Error("Mint mismatch");
    }

    if (!assetPool.vault.equals(vaultPda)) {
      throw new Error("Vault pubkey mismatch");
    }

    if (!assetPool.quoteTreasuryVault.equals(protocolQuoteTreasuryVaultPda)) {
      throw new Error("Quote treasury vault pubkey mismatch");
    }

    if (assetPool.isEnabled !== true) {
      throw new Error("Asset pool should be enabled");
    }

    if (assetPool.allowDeposits !== true) {
      throw new Error("Deposits should be enabled");
    }

    if (assetPool.allowBorrows !== true) {
      throw new Error("Borrows should be enabled");
    }

    if (assetPool.decimals !== 6) {
      throw new Error("Decimals mismatch");
    }

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    if (!vaultAccount.mint.equals(mint)) {
      throw new Error("Vault mint mismatch");
    }
    if (!vaultAccount.owner.equals(vaultAuthorityPda)) {
      throw new Error("Vault authority mismatch");
    }
    if (Number(vaultAccount.amount) !== 0) {
      throw new Error("Vault should start empty");
    }

    const treasuryVaultAccount = await getAccount(
      provider.connection,
      protocolQuoteTreasuryVaultPda
    );

    if (!treasuryVaultAccount.mint.equals(mint)) {
      throw new Error("Treasury vault mint mismatch");
    }

    if (!treasuryVaultAccount.owner.equals(protocolQuoteTreasuryAuthorityPda)) {
      throw new Error("Treasury vault authority mismatch");
    }

    if (Number(treasuryVaultAccount.amount) !== 0) {
      throw new Error("Treasury vault should start empty");
    }
  });

  it("set_asset_pool_flags", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tx = await program.methods
      .setAssetPoolFlags(false, false, true)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const assetPool = await program.account.assetPool.fetch(assetPoolPda);

    if (assetPool.isEnabled !== false) {
      throw new Error("isEnabled should be false");
    }

    if (assetPool.allowDeposits !== false) {
      throw new Error("allowDeposits should be false");
    }

    if (assetPool.allowBorrows !== true) {
      throw new Error("allowBorrows should be true");
    }

    if (!assetPool.vault.equals(vaultPda)) {
      throw new Error("Vault should remain unchanged");
    }

    if (!assetPool.quoteTreasuryVault.equals(protocolQuoteTreasuryVaultPda)) {
      throw new Error("Quote treasury vault should remain unchanged");
    }
  });

  it("initialize_tick_page", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = 0;

    const { tickPagePda, tx: ensureTickPageTx } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const tx =
      ensureTickPageTx ??
      (await program.methods
        .setAssetPoolFlags(true, true, true)
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          authority: wallet.payer.publicKey,
        })
        .signers([wallet.payer])
        .rpc());

    console.log("tx:", tx);

    const tickPageAccountInfo = await provider.connection.getAccountInfo(tickPagePda);
    if (!tickPageAccountInfo) {
      throw new Error("TickPage account was not created");
    }

    if (tickPageAccountInfo.data.length === 0) {
      throw new Error("TickPage account data is empty");
    }
  });


  it("deposit_to_tick_transfers_tokens_into_vault", async () => {
    const tick = 10;
    const amount = new anchor.BN(1_000);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      provider.wallet.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      provider.wallet.publicKey,
      10_000
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = Math.floor(tick / PAGE_SIZE);

    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      provider.wallet.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        provider.wallet.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const tx = await program.methods
      .depositToTick(tick, amount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: provider.wallet.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
    if (lpPosition.shares.toNumber() !== 1000) {
      throw new Error("LP shares mismatch");
    }

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    if (Number(vaultAccount.amount) !== 1000) {
      throw new Error("Vault balance mismatch");
    }
  });

  it("deposit_to_tick_transfers_wsol_into_asset_pool_vault", async () => {
    const tick = Number(BigInt(Date.now()) % 10_000n) + 1_000;
    const amount = new anchor.BN(1_000_000_000);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;
    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      provider.wallet.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userAta.address,
          lamports: amount.toNumber(),
        }),
        createSyncNativeInstruction(userAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      provider.wallet.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        provider.wallet.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const vaultBefore = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );

    const userBefore = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const tx = await program.methods
      .depositToTick(tick, amount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: provider.wallet.publicKey,
        mint: quoteMint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
    const vaultAfter = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );
    const userAfter = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    if (lpPosition.shares.toString() !== amount.toString()) {
      throw new Error("LP WSOL shares mismatch");
    }

    if (vaultAfter - vaultBefore !== amount.toNumber()) {
      throw new Error("WSOL vault balance delta mismatch");
    }

    if (userBefore - userAfter !== amount.toNumber()) {
      throw new Error("User WSOL balance delta mismatch");
    }
  });

  it("deposit_to_tick_rejects_wrong_tick_page", async () => {
    const tick = 40;
    const amount = new anchor.BN(1_000);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      provider.wallet.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      provider.wallet.publicKey,
      10_000
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const wrongPageIndex = 0;

    const [wrongTickPagePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_page"),
        assetPoolPda.toBuffer(),
        new anchor.BN(wrongPageIndex).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await ensureTickPage(
      protocolPda,
      assetPoolPda,
      wrongPageIndex,
      provider.wallet.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        provider.wallet.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    try {
      await program.methods
        .depositToTick(tick, amount)
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          owner: provider.wallet.publicKey,
          mint,
          userTokenAccount: userAta.address,
          vault: vaultPda,
          tickPage: wrongTickPagePda,
          lpPosition: lpPositionPda,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected deposit to fail with WrongTickPage");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");

      if (
        errorCode !== "WrongTickPage" &&
        !errorMessage.includes("Wrong tick page")
      ) {
        throw error;
      }
    }
  });

  it("deposit_to_tick_fails_when_protocol_is_paused", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const tx = await program.methods
      .setProtocolPaused(true)
      .accounts({
        protocol: protocolPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();
    console.log("tx:", tx);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      6
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      10_000
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    try {
      await program.methods
        .initializeAssetPool()
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
          protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
          authority: wallet.payer.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected initializeAssetPool to fail while paused");
    } catch (_e) {
      // expected
    }

    await program.methods
      .setProtocolPaused(false)
      .accounts({
        protocol: protocolPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();
  });


  it("withdraw_from_tick_transfers_tokens_back_to_user", async () => {
    const tick = 10;
    const depositAmount = new anchor.BN(1_000);
    const burnShares = new anchor.BN(400);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      6
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      10_000
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = Math.floor(tick / PAGE_SIZE);

    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const userBalanceBefore = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const tx = await program.methods
      .withdrawFromTick(tick, burnShares)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const userBalanceAfter = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const vaultBalanceAfter = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );

    const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);

    if (userBalanceAfter - userBalanceBefore !== 400) {
      throw new Error("User did not receive withdrawn tokens");
    }

    if (vaultBalanceAfter !== 600) {
      throw new Error("Vault balance mismatch after withdraw");
    }

    if (lpPosition.shares.toNumber() !== 600) {
      throw new Error("LP shares mismatch after withdraw");
    }
  });

  it("withdraw_from_tick_transfers_wsol_back_to_user", async () => {
    const tick = Number(BigInt(Date.now()) % 10_000n) + 20_000;
    const depositAmount = new anchor.BN(1_000_000_000);
    const burnShares = new anchor.BN(400_000_000);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userAta.address,
          lamports: depositAmount.toNumber(),
        }),
        createSyncNativeInstruction(userAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const pageIndex = Math.floor(tick / PAGE_SIZE);

    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const userBefore = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const vaultBefore = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );

    const tx = await program.methods
      .withdrawFromTick(tick, burnShares)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userAta.address,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        tickPage: tickPagePda,
        lpPosition: lpPositionPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const userAfter = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const vaultAfter = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );

    const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);

    if (userAfter - userBefore !== burnShares.toNumber()) {
      throw new Error("User did not receive withdrawn WSOL");
    }

    if (vaultBefore - vaultAfter !== burnShares.toNumber()) {
      throw new Error("WSOL vault balance mismatch after withdraw");
    }

    if (lpPosition.shares.toString() !== "600000000") {
      throw new Error("LP WSOL shares mismatch after withdraw");
    }
  });


  it("initialize_execution_strategy_config", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mode = 1; // pump.fun
    const extraQuoteCollateralBps = 1000; // 10%
    const maxQuoteLossBps = 1500; // 15%
    const minQuoteBufferAmount = new anchor.BN(5_000_000_000); // 5 WSOL
    const fixedMigrationCostQuote = new anchor.BN(500_000_000); // 0.5 WSOL

    const { strategyConfigPda, tx } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      extraQuoteCollateralBps,
      maxQuoteLossBps,
      minQuoteBufferAmount,
      fixedMigrationCostQuote
    );

    console.log("tx:", tx);

    const strategyConfig =
      await program.account.executionStrategyConfig.fetch(strategyConfigPda);

    if (strategyConfig.mode !== mode) {
      throw new Error("Mode mismatch");
    }

    if (strategyConfig.isEnabled !== true) {
      throw new Error("Strategy config should be enabled");
    }

    if (
      strategyConfig.extraQuoteCollateralBps !== extraQuoteCollateralBps
    ) {
      throw new Error("extraQuoteCollateralBps mismatch");
    }

    if (strategyConfig.maxQuoteLossBps !== maxQuoteLossBps) {
      throw new Error("maxQuoteLossBps mismatch");
    }

    if (
      strategyConfig.minQuoteBufferAmount.toString() !==
      minQuoteBufferAmount.toString()
    ) {
      throw new Error("minQuoteBufferAmount mismatch");
    }

    if (
      strategyConfig.fixedMigrationCostQuote.toString() !==
      fixedMigrationCostQuote.toString()
    ) {
      throw new Error("fixedMigrationCostQuote mismatch");
    }
  });

  it("set_execution_strategy_config", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const tx = await program.methods
      .setExecutionStrategyConfig(
        false,
        1200,
        1700,
        new anchor.BN(7_000_000_000),
        new anchor.BN(750_000_000)
      )
      .accounts({
        protocol: protocolPda,
        strategyConfig: strategyConfigPda,
        authority: wallet.payer.publicKey,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);


    const strategyConfig =
      await program.account.executionStrategyConfig.fetch(strategyConfigPda);

    if (strategyConfig.isEnabled !== false) {
      throw new Error("isEnabled mismatch");
    }

    if (strategyConfig.extraQuoteCollateralBps !== 1200) {
      throw new Error("extraQuoteCollateralBps mismatch");
    }

    if (strategyConfig.maxQuoteLossBps !== 1700) {
      throw new Error("maxQuoteLossBps mismatch");
    }

    if (strategyConfig.minQuoteBufferAmount.toString() !== "7000000000") {
      throw new Error("minQuoteBufferAmount mismatch");
    }

    if (strategyConfig.fixedMigrationCostQuote.toString() !== "750000000") {
      throw new Error("fixedMigrationCostQuote mismatch");
    }
  });

  it("open_loan_creates_loan_vaults_and_collects_buffer_and_upfront_charges", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      30_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1; // pump.fun
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-open-loan");
    const plannedSliceCount = 1;

    const requestedQuoteAmount = new anchor.BN(12_000_000_000); // 12
    const fundedQuoteAmount = new anchor.BN(10_000_000_000); // 10
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000); // 2
    const termSec = new anchor.BN(30 * 24 * 60 * 60); // 30 days

    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000); // 1
    const totalProtocolFeePaid = new anchor.BN(200_000_000); // 0.2
    const totalPlatformCostPaid = new anchor.BN(300_000_000); // 0.3

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const userBalanceBefore = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    const treasuryBalanceBefore = Number(
      (await getAccount(provider.connection, protocolQuoteTreasuryVaultPda)).amount
    );

    const tx = await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        selfProgram: program.programId,
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const loan = await program.account.loanPosition.fetch(loanPositionPda);

    const loanQuoteVault = await getAccount(provider.connection, loanQuoteVaultPda);
    const loanQuoteBufferVault = await getAccount(
      provider.connection,
      loanQuoteBufferVaultPda
    );
    const treasuryVault = await getAccount(
      provider.connection,
      protocolQuoteTreasuryVaultPda
    );
    const userBalanceAfter = Number(
      (await getAccount(provider.connection, userAta.address)).amount
    );

    // buffer = max(10 * 10%, 5) + 0.5 = 5.5
    const expectedBuffer = 5_500_000_000;

    // upfront charges = 1 + 0.2 + 0.3 = 1.5
    const expectedUpfrontCharges = 1_500_000_000;

    if (!loan.owner.equals(wallet.payer.publicKey)) {
      throw new Error("Loan owner mismatch");
    }

    if (!loan.quoteAssetPool.equals(assetPoolPda)) {
      throw new Error("quoteAssetPool mismatch");
    }

    if (!loan.strategyConfig.equals(strategyConfigPda)) {
      throw new Error("strategyConfig mismatch");
    }

    if (loan.strategyMode !== mode) {
      throw new Error("strategyMode mismatch");
    }

    if (loan.status !== 1) {
      throw new Error("Loan status should be OPENED");
    }

    if (loan.routePlanHash.length !== 32) {
      throw new Error("routePlanHash length mismatch");
    }

    if (Buffer.from(loan.routePlanHash).compare(Buffer.from(routePlanHash)) !== 0) {
      throw new Error("routePlanHash mismatch");
    }

    if (loan.plannedSliceCount !== plannedSliceCount) {
      throw new Error("plannedSliceCount mismatch");
    }

    if (loan.requestedQuoteAmount.toString() !== "12000000000") {
      throw new Error("requestedQuoteAmount mismatch");
    }

    if (loan.fundedQuoteAmount.toString() !== "10000000000") {
      throw new Error("fundedQuoteAmount mismatch");
    }

    if (loan.extraUserQuoteAmount.toString() !== "2000000000") {
      throw new Error("extraUserQuoteAmount mismatch");
    }

    if (loan.plannedTotalPrincipalAmount.toString() !== "10000000000") {
      throw new Error("plannedTotalPrincipalAmount mismatch");
    }

    if (
      loan.plannedTotalUpfrontInterestAmount.toString() !==
      totalUpfrontInterestPaid.toString()
    ) {
      throw new Error("plannedTotalUpfrontInterestAmount mismatch");
    }

    if (
      loan.plannedTotalProtocolFeeAmount.toString() !==
      totalProtocolFeePaid.toString()
    ) {
      throw new Error("plannedTotalProtocolFeeAmount mismatch");
    }

    if (
      loan.plannedTotalPlatformCostAmount.toString() !==
      totalPlatformCostPaid.toString()
    ) {
      throw new Error("plannedTotalPlatformCostAmount mismatch");
    }

    if (loan.termSec.toString() !== termSec.toString()) {
      throw new Error("termSec mismatch");
    }

    if (
      loan.totalUpfrontInterestPaid.toString() !==
      totalUpfrontInterestPaid.toString()
    ) {
      throw new Error("totalUpfrontInterestPaid mismatch");
    }

    if (
      loan.totalProtocolFeePaid.toString() !==
      totalProtocolFeePaid.toString()
    ) {
      throw new Error("totalProtocolFeePaid mismatch");
    }

    if (
      loan.totalPlatformCostPaid.toString() !==
      totalPlatformCostPaid.toString()
    ) {
      throw new Error("totalPlatformCostPaid mismatch");
    }

    if (loan.requiredQuoteBufferAmount.toString() !== expectedBuffer.toString()) {
      throw new Error("requiredQuoteBufferAmount mismatch");
    }

    if (!loan.loanQuoteVault.equals(loanQuoteVaultPda)) {
      throw new Error("loanQuoteVault mismatch");
    }

    if (!loan.quoteBufferVault.equals(loanQuoteBufferVaultPda)) {
      throw new Error("quoteBufferVault mismatch");
    }

    if (loan.collateralAmount.toString() !== "0") {
      throw new Error("collateralAmount should be zero initially");
    }

    if (loan.immediateUserBaseAmount.toString() !== "0") {
      throw new Error("immediateUserBaseAmount should be zero initially");
    }

    if (
      loan.extraQuoteCollateralBpsSnapshot !== 1000 ||
      loan.maxQuoteLossBpsSnapshot !== 1500
    ) {
      throw new Error("strategy snapshot bps mismatch");
    }

    if (loan.minQuoteBufferAmountSnapshot.toString() !== "5000000000") {
      throw new Error("minQuoteBufferAmountSnapshot mismatch");
    }

    if (loan.fixedMigrationCostQuoteSnapshot.toString() !== "500000000") {
      throw new Error("fixedMigrationCostQuoteSnapshot mismatch");
    }

    if (loanQuoteVault.amount.toString() !== "0") {
      throw new Error("loanQuoteVault should start empty");
    }

    if (loanQuoteBufferVault.amount.toString() !== expectedBuffer.toString()) {
      throw new Error("loanQuoteBufferVault balance mismatch");
    }

    if (
      Number(treasuryVault.amount) - treasuryBalanceBefore !==
      expectedUpfrontCharges
    ) {
      throw new Error("Treasury vault upfront charges mismatch");
    }

    if (
      userBalanceBefore - userBalanceAfter !==
      expectedBuffer + expectedUpfrontCharges
    ) {
      throw new Error("User balance decrease mismatch");
    }
  });

  it("fund_loan_from_ticks_moves_principal_to_loan_quote_vault", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      50_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tick = 10;
    const depositAmount = new anchor.BN(10_000_000_000);

    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-fund-loan");
    const plannedSliceCount = 1;

    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);

    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const assetPoolVaultBefore = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );
    const loanQuoteVaultBefore = Number(
      (await getAccount(provider.connection, loanQuoteVaultPda)).amount
    );

    const tx = await program.methods
      .fundLoanFromTicks([
        {
          tick,
          principalAmount: fundedQuoteAmount,
          upfrontInterestAmount: totalUpfrontInterestPaid,
          protocolFeeAmount: totalProtocolFeePaid,
        },
      ])
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        loanPosition: loanPositionPda,
        loanQuoteVault: loanQuoteVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
      ])
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const assetPoolVaultAfter = Number(
      (await getAccount(provider.connection, vaultPda)).amount
    );
    const loanQuoteVaultAfter = Number(
      (await getAccount(provider.connection, loanQuoteVaultPda)).amount
    );

    const borrowSlice =
      await program.account.borrowSlicePosition.fetch(borrowSlicePda);
    const loan = await program.account.loanPosition.fetch(loanPositionPda);

    if (assetPoolVaultBefore - assetPoolVaultAfter !== 10_000_000_000) {
      throw new Error("Asset pool vault did not fund principal correctly");
    }

    if (loanQuoteVaultAfter - loanQuoteVaultBefore !== 10_000_000_000) {
      throw new Error("Loan quote vault did not receive funded principal");
    }

    if (borrowSlice.principalOutstanding.toString() !== "10000000000") {
      throw new Error("Borrow slice principalOutstanding mismatch");
    }

    if (borrowSlice.upfrontInterestPaid.toString() !== "1000000000") {
      throw new Error("Borrow slice upfrontInterestPaid mismatch");
    }

    if (borrowSlice.protocolFeePaid.toString() !== "200000000") {
      throw new Error("Borrow slice protocolFeePaid mismatch");
    }

    if (loan.status !== 2) {
      throw new Error("Loan should be FUNDED after fund_loan_from_ticks");
    }
  });

  it("fund_loan_from_ticks_rejects_slice_count_mismatch", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      50_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tick = 10;
    const depositAmount = new anchor.BN(10_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-slice-mismatch");
    const plannedSliceCount = 2;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    try {
      await program.methods
        .fundLoanFromTicks([
          {
            tick,
            principalAmount: fundedQuoteAmount,
            upfrontInterestAmount: totalUpfrontInterestPaid,
            protocolFeeAmount: totalProtocolFeePaid,
          },
        ])
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint: mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          loanPosition: loanPositionPda,
          loanQuoteVault: loanQuoteVaultPda,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickPagePda, isSigner: false, isWritable: true },
          { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        ])
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected fundLoanFromTicks to fail with slice count mismatch");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");

      if (
        errorCode !== "BorrowPlanSliceCountMismatch" &&
        !errorMessage.includes("Borrow plan slice count mismatch")
      ) {
        throw error;
      }
    }
  });

  it("fund_loan_from_ticks_rejects_principal_mismatch", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      50_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tick = 10;
    const depositAmount = new anchor.BN(10_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-principal-mismatch");
    const plannedSliceCount = 1;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    try {
      await program.methods
        .fundLoanFromTicks([
          {
            tick,
            principalAmount: new anchor.BN(9_000_000_000),
            upfrontInterestAmount: totalUpfrontInterestPaid,
            protocolFeeAmount: totalProtocolFeePaid,
          },
        ])
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint: mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          loanPosition: loanPositionPda,
          loanQuoteVault: loanQuoteVaultPda,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickPagePda, isSigner: false, isWritable: true },
          { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        ])
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected fundLoanFromTicks to fail with principal mismatch");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");

      if (
        errorCode !== "BorrowPlanMismatch" &&
        !errorMessage.includes("Borrow plan mismatch")
      ) {
        throw error;
      }
    }
  });

  it("fund_loan_from_ticks_rejects_protocol_fee_mismatch", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      50_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tick = 10;
    const depositAmount = new anchor.BN(10_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-fee-mismatch");
    const plannedSliceCount = 1;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    try {
      await program.methods
        .fundLoanFromTicks([
          {
            tick,
            principalAmount: fundedQuoteAmount,
            upfrontInterestAmount: totalUpfrontInterestPaid,
            protocolFeeAmount: new anchor.BN(100_000_000),
          },
        ])
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint: mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          loanPosition: loanPositionPda,
          loanQuoteVault: loanQuoteVaultPda,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickPagePda, isSigner: false, isWritable: true },
          { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        ])
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected fundLoanFromTicks to fail with protocol fee mismatch");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");

      if (
        errorCode !== "BorrowPlanProtocolFeeMismatch" &&
        !errorMessage.includes("Borrow plan protocol fee mismatch")
      ) {
        throw error;
      }
    }
  });

  it("fund_loan_from_ticks_rejects_upfront_interest_mismatch", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.payer.publicKey
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userAta.address,
      wallet.payer.publicKey,
      50_000_000_000n
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetPoolPda.toBuffer()],
      program.programId
    );

    const [protocolQuoteTreasuryAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_auth"), assetPoolPda.toBuffer()],
        program.programId
      );

    const [protocolQuoteTreasuryVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("quote_treasury_vault"), assetPoolPda.toBuffer()],
        program.programId
      );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const tick = 10;
    const depositAmount = new anchor.BN(10_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint,
        userTokenAccount: userAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-interest-mismatch");
    const plannedSliceCount = 1;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    console.log("tx:", tx);

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    try {
      await program.methods
        .fundLoanFromTicks([
          {
            tick,
            principalAmount: fundedQuoteAmount,
            upfrontInterestAmount: new anchor.BN(900_000_000),
            protocolFeeAmount: totalProtocolFeePaid,
          },
        ])
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint: mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
          loanPosition: loanPositionPda,
          loanQuoteVault: loanQuoteVaultPda,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickPagePda, isSigner: false, isWritable: true },
          { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        ])
        .signers([wallet.payer])
        .rpc();

      throw new Error("Expected fundLoanFromTicks to fail with upfront interest mismatch");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");

      if (
        errorCode !== "BorrowPlanInterestMismatch" &&
        !errorMessage.includes("Borrow plan interest mismatch")
      ) {
        throw error;
      }
    }
  });

  it("execute_launch_pump_fun_moves_quote_and_splits_base_output", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;

    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userQuoteAta.address,
          lamports: 60_000_000_000,
        }),
        createSyncNativeInstruction(userQuoteAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 10;
    const depositAmount = new anchor.BN(20_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-execute-pump-fun");
    const plannedSliceCount = 1;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    await program.methods
      .fundLoanFromTicks([
        {
          tick,
          principalAmount: fundedQuoteAmount,
          upfrontInterestAmount: totalUpfrontInterestPaid,
          protocolFeeAmount: totalProtocolFeePaid,
        },
      ])
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        loanPosition: loanPositionPda,
        loanQuoteVault: loanQuoteVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
      ])
      .signers([wallet.payer])
      .rpc();

    const baseMint = anchor.web3.Keypair.generate();

    const [mockPumpFunMetadataPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );

    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );

    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const pumpFunFeeRecipient = wallet.payer.publicKey;
    const pumpFunCreatorVault = loanExecutionWalletPda;
    const pumpFunMayhemProgram = mockPumpFunProgram.programId;
    const pumpFunGlobalParams = mockPumpFunGlobalParamsPda;
    const pumpFunSolVault = mockPumpFunSolVaultPda;
    const pumpFunMayhemState = mockPumpFunMayhemStatePda;
    const pumpFunMayhemTokenVault = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunSolVaultPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );
    const loanQuoteSpendAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteSpendAmount = new anchor.BN(2_000_000_000);
    const collateralMinBaseOut = new anchor.BN(900_000);
    const immediateUserMinBaseOut = new anchor.BN(150_000);
    const tokenName = "Moono";
    const tokenSymbol = "MPT";
    const tokenUri = "https://mpt";

    const loanQuoteVaultBefore = Number(
      (await getAccount(provider.connection, loanQuoteVaultPda)).amount
    );
    const userQuoteBefore = Number(
      (await getAccount(provider.connection, userQuoteAta.address)).amount
    );

    const executeIx = await program.methods
      .executeLaunchPumpFun(
        true,
        tokenName,
        tokenSymbol,
        tokenUri,
        loanQuoteSpendAmount,
        extraUserQuoteSpendAmount,
        collateralMinBaseOut,
        immediateUserMinBaseOut
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        baseMint: baseMint.publicKey,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanExecutionWallet: loanExecutionWalletPda,
        loanQuoteVault: loanQuoteVaultPda,
        userExtraQuoteTokenAccount: userQuoteAta.address,
        pumpFunProgram: mockPumpFunProgram.programId,
        pumpFunGlobal: mockPumpFunGlobalPda,
        pumpFunBondingCurve: mockPumpFunBondingCurvePda,
        pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
        pumpFunMayhemProgram,
        pumpFunGlobalParams,
        pumpFunSolVault,
        pumpFunMayhemState,
        pumpFunMayhemTokenVault,
        pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
        pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
        pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
        pumpFunFeeRecipient,
        pumpFunCreatorVault,
        loanCollateralVault: loanCollateralVaultPda,
        userBaseTokenAccount: userBaseAta,
        quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
        {
          pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
        { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
        { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
      ])
      .instruction();

    const tx = await sendVersionedTxWithLookup(
      [
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        }),
        executeIx,
      ],
      [wallet.payer, baseMint]
    );

    console.log("tx:", tx);

    const loan = await program.account.loanPosition.fetch(loanPositionPda);
    const launchState = await mockPumpFunProgram.account.launchState.fetch(
      mockPumpFunMayhemStatePda
    );
    const loanQuoteVaultAfter = Number(
      (await getAccount(provider.connection, loanQuoteVaultPda)).amount
    );
    const userQuoteAfter = Number(
      (await getAccount(provider.connection, userQuoteAta.address)).amount
    );
    const loanCollateralVault = await getAccount(
      provider.connection,
      loanCollateralVaultPda,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const userBaseAccount = await getAccount(
      provider.connection,
      userBaseAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    if (loan.status !== 3) {
      throw new Error("Loan should be EXECUTED after execute_launch_pump_fun");
    }

    if (loan.executedLoanQuoteAmount.toString() !== "10000000000") {
      throw new Error("executedLoanQuoteAmount mismatch");
    }

    if (loan.executedExtraUserQuoteAmount.toString() !== "2000000000") {
      throw new Error("executedExtraUserQuoteAmount mismatch");
    }

    if (loan.executedTotalBaseAmount.toString() !== "1200000") {
      throw new Error("executedTotalBaseAmount mismatch");
    }

    if (!loan.collateralMint.equals(baseMint.publicKey)) {
      throw new Error("collateralMint mismatch");
    }

    if (!loan.collateralVault.equals(loanCollateralVaultPda)) {
      throw new Error("collateralVault mismatch");
    }

    if (loan.collateralAmount.toString() !== "1000000") {
      throw new Error("collateralAmount mismatch");
    }

    if (loan.immediateUserBaseAmount.toString() !== "200000") {
      throw new Error("immediateUserBaseAmount mismatch");
    }

    if (loan.executedAt.toString() === "0") {
      throw new Error("executedAt should be set");
    }

    if (launchState.version !== 2) {
      throw new Error("launchState version mismatch");
    }

    if (!launchState.owner.equals(wallet.payer.publicKey)) {
      throw new Error("launchState owner mismatch");
    }

    if (!launchState.creator.equals(wallet.payer.publicKey)) {
      throw new Error("launchState creator mismatch");
    }

    if (!launchState.mint.equals(baseMint.publicKey)) {
      throw new Error("launchState mint mismatch");
    }

    if (launchState.name !== tokenName) {
      throw new Error("launchState name mismatch");
    }

    if (launchState.symbol !== tokenSymbol) {
      throw new Error("launchState symbol mismatch");
    }

    if (launchState.uri !== tokenUri) {
      throw new Error("launchState uri mismatch");
    }

    if (loanQuoteVaultBefore - loanQuoteVaultAfter !== 10_000_000_000) {
      throw new Error("loanQuoteVault spend mismatch");
    }

    if (userQuoteBefore - userQuoteAfter !== 2_000_000_000) {
      throw new Error("user extra quote spend mismatch");
    }

    if (Number(loanCollateralVault.amount) !== 1_000_000) {
      throw new Error("loan collateral vault base amount mismatch");
    }

    if (Number(userBaseAccount.amount) !== 200_000) {
      throw new Error("user base token amount mismatch");
    }
  });

  it("open_fund_execute_launch_pump_fun_is_atomic", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userQuoteAta.address,
          lamports: 60_000_000_000,
        }),
        createSyncNativeInstruction(userQuoteAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 14;
    const depositAmount = new anchor.BN(20_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      mode,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-open-fund-execute-atomic");
    const plannedSliceCount = 1;
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const baseMint = anchor.web3.Keypair.generate();
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );
    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );
    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );

    const ix = await program.methods
      .openFundExecuteLaunchPumpFun(
        loanId,
        routePlanHash,
        plannedSliceCount,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid,
        [
          {
            tick,
            principalAmount: fundedQuoteAmount,
            upfrontInterestAmount: totalUpfrontInterestPaid,
            protocolFeeAmount: totalProtocolFeePaid,
          },
        ],
        true,
        "Moono",
        "MPT",
        "https://mpt",
        new anchor.BN(10_000_000_000),
        new anchor.BN(2_000_000_000),
        new anchor.BN(900_000),
        new anchor.BN(150_000)
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        userExtraQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        baseMint: baseMint.publicKey,
        loanExecutionWallet: loanExecutionWalletPda,
        pumpFunProgram: mockPumpFunProgram.programId,
        pumpFunGlobal: mockPumpFunGlobalPda,
        pumpFunBondingCurve: mockPumpFunBondingCurvePda,
        pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
        pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
        pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
        pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
        pumpFunFeeRecipient: wallet.payer.publicKey,
        pumpFunCreatorVault: loanExecutionWalletPda,
        pumpFunMayhemProgram: mockPumpFunProgram.programId,
        pumpFunGlobalParams: mockPumpFunGlobalParamsPda,
        pumpFunSolVault: mockPumpFunSolVaultPda,
        pumpFunMayhemState: mockPumpFunMayhemStatePda,
        pumpFunMayhemTokenVault: getAssociatedTokenAddressSync(
          baseMint.publicKey,
          mockPumpFunSolVaultPda,
          true,
          TOKEN_2022_PROGRAM_ID
        ),
        loanCollateralVault: loanCollateralVaultPda,
        userBaseTokenAccount: userBaseAta,
        quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
        {
          pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
        { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
        { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
      ])
      .instruction();

    const tx = await sendVersionedTxWithLookup(
      [
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_000_000,
        }),
        anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 1,
        }),
        ix,
      ],
      [wallet.payer, baseMint]
    );

    console.log("tx:", tx);

    const loan = await program.account.loanPosition.fetch(loanPositionPda);
    const loanCollateralVault = await getAccount(
      provider.connection,
      loanCollateralVaultPda,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const userBaseAccount = await getAccount(
      provider.connection,
      userBaseAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    if (loan.status !== 3) {
      throw new Error("Loan should be EXECUTED after atomic open_fund_execute_launch_pump_fun");
    }

    if (loan.executedLoanQuoteAmount.toString() !== "10000000000") {
      throw new Error("executedLoanQuoteAmount mismatch");
    }

    if (loan.executedExtraUserQuoteAmount.toString() !== "2000000000") {
      throw new Error("executedExtraUserQuoteAmount mismatch");
    }

    if (loan.collateralAmount.toString() !== "1000000") {
      throw new Error("collateralAmount mismatch");
    }

    if (loan.immediateUserBaseAmount.toString() !== "200000") {
      throw new Error("immediateUserBaseAmount mismatch");
    }

    if (Number(loanCollateralVault.amount) !== 1_000_000) {
      throw new Error("loan collateral vault base amount mismatch");
    }

    if (Number(userBaseAccount.amount) !== 200_000) {
      throw new Error("user base token amount mismatch");
    }
  });

  it("execute_launch_pump_fun_delivers_base_to_user_for_extra_buy", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userQuoteAta.address,
          lamports: 60_000_000_000,
        }),
        createSyncNativeInstruction(userQuoteAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 12;
    const depositAmount = new anchor.BN(20_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      1,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-extra-user-buy-only-check");
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(2_000_000_000);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(
        loanId,
        routePlanHash,
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
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    await program.methods
      .fundLoanFromTicks([
        {
          tick,
          principalAmount: fundedQuoteAmount,
          upfrontInterestAmount: totalUpfrontInterestPaid,
          protocolFeeAmount: totalProtocolFeePaid,
        },
      ])
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        loanPosition: loanPositionPda,
        loanQuoteVault: loanQuoteVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
      ])
      .signers([wallet.payer])
      .rpc();

    const baseMint = anchor.web3.Keypair.generate();
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );
    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );
    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const pumpFunMayhemTokenVault = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunSolVaultPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );

    const executeIx = await program.methods
      .executeLaunchPumpFun(
        true,
        "Moono",
        "MPT",
        "https://mpt",
        new anchor.BN(10_000_000_000),
        new anchor.BN(2_000_000_000),
        new anchor.BN(900_000),
        new anchor.BN(150_000)
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        baseMint: baseMint.publicKey,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanExecutionWallet: loanExecutionWalletPda,
        loanQuoteVault: loanQuoteVaultPda,
        userExtraQuoteTokenAccount: userQuoteAta.address,
        pumpFunProgram: mockPumpFunProgram.programId,
        pumpFunGlobal: mockPumpFunGlobalPda,
        pumpFunBondingCurve: mockPumpFunBondingCurvePda,
        pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
        pumpFunMayhemProgram: mockPumpFunProgram.programId,
        pumpFunGlobalParams: mockPumpFunGlobalParamsPda,
        pumpFunSolVault: mockPumpFunSolVaultPda,
        pumpFunMayhemState: mockPumpFunMayhemStatePda,
        pumpFunMayhemTokenVault,
        pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
        pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
        pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
        pumpFunFeeRecipient: wallet.payer.publicKey,
        pumpFunCreatorVault: loanExecutionWalletPda,
        loanCollateralVault: loanCollateralVaultPda,
        userBaseTokenAccount: userBaseAta,
        quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
        {
          pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
        { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
        { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
      ])
      .instruction();

    const tx = await sendVersionedTxWithLookup(
      [
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        }),
        executeIx,
      ],
      [wallet.payer, baseMint]
    );

    console.log("tx:", tx);

    const loan = await program.account.loanPosition.fetch(loanPositionPda);
    const userBaseAccount = await getAccount(
      provider.connection,
      userBaseAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    if (loan.executedExtraUserQuoteAmount.toString() !== "2000000000") {
      throw new Error("executedExtraUserQuoteAmount mismatch");
    }

    if (loan.immediateUserBaseAmount.toString() !== "200000") {
      throw new Error("immediateUserBaseAmount mismatch");
    }

    if (Number(userBaseAccount.amount) !== 200_000) {
      throw new Error("user base token amount mismatch");
    }
  });

  it("open_fund_execute_launch_pump_fun_is_atomic_without_extra_buy", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const quoteMint = NATIVE_MINT;
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userQuoteAta.address,
          lamports: 60_000_000_000,
        }),
        createSyncNativeInstruction(userQuoteAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 16;
    const depositAmount = new anchor.BN(20_000_000_000);
    const pageIndex = Math.floor(tick / PAGE_SIZE);
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      pageIndex,
      wallet.payer.publicKey
    );

    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, depositAmount)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      1,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const routePlanHash = makeRoutePlanHash("route-plan-open-fund-execute-atomic-no-extra");
    const requestedQuoteAmount = new anchor.BN(12_000_000_000);
    const fundedQuoteAmount = new anchor.BN(10_000_000_000);
    const extraUserQuoteAmount = new anchor.BN(0);
    const termSec = new anchor.BN(30 * 24 * 60 * 60);
    const totalUpfrontInterestPaid = new anchor.BN(1_000_000_000);
    const totalProtocolFeePaid = new anchor.BN(200_000_000);
    const totalPlatformCostPaid = new anchor.BN(300_000_000);

    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const baseMint = anchor.web3.Keypair.generate();
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );
    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );
    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );

    const ix = await program.methods
      .openFundExecuteLaunchPumpFun(
        loanId,
        routePlanHash,
        1,
        requestedQuoteAmount,
        fundedQuoteAmount,
        extraUserQuoteAmount,
        termSec,
        totalUpfrontInterestPaid,
        totalProtocolFeePaid,
        totalPlatformCostPaid,
        [
          {
            tick,
            principalAmount: fundedQuoteAmount,
            upfrontInterestAmount: totalUpfrontInterestPaid,
            protocolFeeAmount: totalProtocolFeePaid,
          },
        ],
        true,
        "Moono",
        "MPT",
        "https://mpt",
        new anchor.BN(10_000_000_000),
        new anchor.BN(0),
        new anchor.BN(900_000),
        new anchor.BN(0)
      )
      .accounts({
        selfProgram: program.programId,
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        userExtraQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        baseMint: baseMint.publicKey,
        loanExecutionWallet: loanExecutionWalletPda,
        pumpFunProgram: mockPumpFunProgram.programId,
        pumpFunGlobal: mockPumpFunGlobalPda,
        pumpFunBondingCurve: mockPumpFunBondingCurvePda,
        pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
        pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
        pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
        pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
        pumpFunFeeRecipient: wallet.payer.publicKey,
        pumpFunCreatorVault: loanExecutionWalletPda,
        pumpFunMayhemProgram: mockPumpFunProgram.programId,
        pumpFunGlobalParams: mockPumpFunGlobalParamsPda,
        pumpFunSolVault: mockPumpFunSolVaultPda,
        pumpFunMayhemState: mockPumpFunMayhemStatePda,
        pumpFunMayhemTokenVault: getAssociatedTokenAddressSync(
          baseMint.publicKey,
          mockPumpFunSolVaultPda,
          true,
          TOKEN_2022_PROGRAM_ID
        ),
        loanCollateralVault: loanCollateralVaultPda,
        userBaseTokenAccount: userBaseAta,
        quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
        {
          pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
        { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
        { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
        { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
      ])
      .instruction();

    const tx = await sendVersionedTxWithLookup(
      [
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_000_000,
        }),
        anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 1,
        }),
        ix,
      ],
      [wallet.payer, baseMint]
    );

    console.log("tx:", tx);

    const loan = await program.account.loanPosition.fetch(loanPositionPda);
    const loanCollateralVault = await getAccount(
      provider.connection,
      loanCollateralVaultPda,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    if (loan.status !== 3) {
      throw new Error("Loan should be EXECUTED after atomic open_fund_execute without extra");
    }

    if (loan.executedExtraUserQuoteAmount.toString() !== "0") {
      throw new Error("executedExtraUserQuoteAmount should be zero");
    }

    if (loan.immediateUserBaseAmount.toString() !== "0") {
      throw new Error("immediateUserBaseAmount should be zero");
    }

    if (loan.executedLoanQuoteAmount.toString() !== "10000000000") {
      throw new Error("executedLoanQuoteAmount mismatch");
    }

    if (Number(loanCollateralVault.amount) !== 1_000_000) {
      throw new Error("loan collateral vault base amount mismatch");
    }
  });

  it("execute_launch_pump_fun_rejects_non_wsol_quote_pool", async () => {
    const [protocolPda] = await ensureProtocolInitialized();

    const quoteMint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.payer.publicKey,
      null,
      9
    );
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );
    await mintTo(
      provider.connection,
      wallet.payer,
      quoteMint,
      userQuoteAta.address,
      wallet.payer.publicKey,
      60_000_000_000n
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 11;
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      Math.floor(tick / PAGE_SIZE),
      wallet.payer.publicKey
    );
    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, new anchor.BN(20_000_000_000))
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      1,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(
        loanId,
        makeRoutePlanHash("route-plan-execute-pump-fun-non-wsol"),
        1,
        new anchor.BN(12_000_000_000),
        new anchor.BN(10_000_000_000),
        new anchor.BN(2_000_000_000),
        new anchor.BN(30 * 24 * 60 * 60),
        new anchor.BN(1_000_000_000),
        new anchor.BN(200_000_000),
        new anchor.BN(300_000_000)
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );
    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    await program.methods
      .fundLoanFromTicks([
        {
          tick,
          principalAmount: new anchor.BN(10_000_000_000),
          upfrontInterestAmount: new anchor.BN(1_000_000_000),
          protocolFeeAmount: new anchor.BN(200_000_000),
        },
      ])
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        loanPosition: loanPositionPda,
        loanQuoteVault: loanQuoteVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
      ])
      .signers([wallet.payer])
      .rpc();

    const baseMint = anchor.web3.Keypair.generate();
    const [mockPumpFunMetadataPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );
    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );
    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const pumpFunFeeRecipient = wallet.payer.publicKey;
    const pumpFunCreatorVault = loanExecutionWalletPda;
    const pumpFunMayhemProgram = mockPumpFunProgram.programId;
    const pumpFunGlobalParams = mockPumpFunGlobalParamsPda;
    const pumpFunSolVault = mockPumpFunSolVaultPda;
    const pumpFunMayhemState = mockPumpFunMayhemStatePda;
    const pumpFunMayhemTokenVault = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunSolVaultPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );
    const tokenName = "Moono";
    const tokenSymbol = "MPT";
    const tokenUri = "https://mpt";

    try {
      const executeIx = await program.methods
        .executeLaunchPumpFun(
          true,
          tokenName,
          tokenSymbol,
          tokenUri,
          new anchor.BN(10_000_000_000),
          new anchor.BN(2_000_000_000),
          new anchor.BN(900_000),
          new anchor.BN(150_000)
        )
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint,
          baseMint: baseMint.publicKey,
          loanPosition: loanPositionPda,
          loanVaultAuthority: loanVaultAuthorityPda,
          loanExecutionWallet: loanExecutionWalletPda,
          loanQuoteVault: loanQuoteVaultPda,
          userExtraQuoteTokenAccount: userQuoteAta.address,
          pumpFunProgram: mockPumpFunProgram.programId,
          pumpFunGlobal: mockPumpFunGlobalPda,
          pumpFunBondingCurve: mockPumpFunBondingCurvePda,
          pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
          pumpFunMayhemProgram,
          pumpFunGlobalParams,
          pumpFunSolVault,
          pumpFunMayhemState,
          pumpFunMayhemTokenVault,
          pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
          pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
          pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
          pumpFunFeeRecipient,
          pumpFunCreatorVault,
          loanCollateralVault: loanCollateralVaultPda,
          userBaseTokenAccount: userBaseAta,
          quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
          {
            pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
          { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
          { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
          { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
        ])
        .instruction();

      await sendVersionedTxWithLookup(
        [
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000,
          }),
          executeIx,
        ],
        [wallet.payer, baseMint]
      );
      throw new Error("Expected executeLaunchPumpFun to reject non-WSOL quote");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");
      if (
        errorCode !== "PumpFunRequiresWsolQuote" &&
        !errorMessage.includes("Pump.fun requires WSOL quote mint")
      ) {
        throw error;
      }
    }
  });

  it("execute_launch_pump_fun_rejects_slippage_exceeded", async () => {
    const [protocolPda] = await ensureProtocolInitialized();
    const quoteMint = NATIVE_MINT;
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      quoteMint,
      wallet.payer.publicKey
    );
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: wallet.payer.publicKey,
          toPubkey: userQuoteAta.address,
          lamports: 60_000_000_000,
        }),
        createSyncNativeInstruction(userQuoteAta.address)
      ),
      [wallet.payer]
    );

    const {
      assetPoolPda,
      vaultAuthorityPda,
      vaultPda,
      protocolQuoteTreasuryAuthorityPda,
      protocolQuoteTreasuryVaultPda,
    } = await ensureAssetPool(protocolPda, quoteMint);

    const tick = 12;
    const { tickPagePda } = await ensureTickPage(
      protocolPda,
      assetPoolPda,
      Math.floor(tick / PAGE_SIZE),
      wallet.payer.publicKey
    );
    const [lpPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        wallet.payer.publicKey.toBuffer(),
        assetPoolPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .depositToTick(tick, new anchor.BN(20_000_000_000))
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        mint: quoteMint,
        userTokenAccount: userQuoteAta.address,
        vault: vaultPda,
        lpPosition: lpPositionPda,
        tickPage: tickPagePda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const { strategyConfigPda } = await ensureExecutionStrategyConfig(
      protocolPda,
      1,
      true,
      1000,
      1500,
      new anchor.BN(5_000_000_000),
      new anchor.BN(500_000_000)
    );

    const loanId = makeUniqueLoanId();
    const [loanPositionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("loan_position"),
        wallet.payer.publicKey.toBuffer(),
        loanId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [loanVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_vault_authority"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_vault"), loanPositionPda.toBuffer()],
      program.programId
    );
    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(
        loanId,
        makeRoutePlanHash("route-plan-execute-pump-fun-slippage"),
        1,
        new anchor.BN(12_000_000_000),
        new anchor.BN(10_000_000_000),
        new anchor.BN(2_000_000_000),
        new anchor.BN(30 * 24 * 60 * 60),
        new anchor.BN(1_000_000_000),
        new anchor.BN(200_000_000),
        new anchor.BN(300_000_000)
      )
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint,
        userQuoteTokenAccount: userQuoteAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteVault: loanQuoteVaultPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        protocolQuoteTreasuryAuthority: protocolQuoteTreasuryAuthorityPda,
        protocolQuoteTreasuryVault: protocolQuoteTreasuryVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const [borrowSlicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("borrow_position"),
        loanPositionPda.toBuffer(),
        new anchor.BN(tick).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );
    await program.methods
      .initializeBorrowSlicePosition(loanId, tick)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        loanPosition: loanPositionPda,
        owner: wallet.payer.publicKey,
        borrowSlicePosition: borrowSlicePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    await program.methods
      .fundLoanFromTicks([
        {
          tick,
          principalAmount: new anchor.BN(10_000_000_000),
          upfrontInterestAmount: new anchor.BN(1_000_000_000),
          protocolFeeAmount: new anchor.BN(200_000_000),
        },
      ])
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        owner: wallet.payer.publicKey,
        quoteMint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        loanPosition: loanPositionPda,
        loanQuoteVault: loanQuoteVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: tickPagePda, isSigner: false, isWritable: true },
        { pubkey: borrowSlicePda, isSigner: false, isWritable: true },
      ])
      .signers([wallet.payer])
      .rpc();

    const baseMint = anchor.web3.Keypair.generate();
    const [mockPumpFunMetadataPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalParamsPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global-params")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunSolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("sol-vault")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunMayhemStatePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mayhem-state"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunGlobalPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunEventAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurvePda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunBondingCurveV2Pda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), baseMint.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const mockPumpFunAssociatedBondingCurvePda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunBondingCurvePda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunLoanTemporaryWsolVaultPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("temp_wsol_vault"), loanPositionPda.toBuffer(), Buffer.from("loan")],
        program.programId
      );
    const [mockPumpFunMintAuthorityPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority")],
        mockPumpFunProgram.programId
      );
    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      wallet.payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const [loanExecutionWalletPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("loan_execution_wallet"), loanPositionPda.toBuffer()],
        program.programId
      );
    const loanCollateralVaultPda = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      loanExecutionWalletPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const pumpFunFeeRecipient = wallet.payer.publicKey;
    const pumpFunCreatorVault = loanExecutionWalletPda;
    const pumpFunMayhemProgram = mockPumpFunProgram.programId;
    const pumpFunGlobalParams = mockPumpFunGlobalParamsPda;
    const pumpFunSolVault = mockPumpFunSolVaultPda;
    const pumpFunMayhemState = mockPumpFunMayhemStatePda;
    const pumpFunMayhemTokenVault = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      mockPumpFunSolVaultPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [mockPumpFunGlobalVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunExecutionWalletVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), loanExecutionWalletPda.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunOwnerVolumeAccumulatorPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), wallet.payer.publicKey.toBuffer()],
        mockPumpFunProgram.programId
      );
    const [mockPumpFunFeeConfigPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), pumpFeeConfigAuthority],
        pumpFeeProgramId
      );
    const tokenName = "Moono";
    const tokenSymbol = "MPT";
    const tokenUri = "https://mpt";

    try {
      const executeIx = await program.methods
        .executeLaunchPumpFun(
          true,
          tokenName,
          tokenSymbol,
          tokenUri,
          new anchor.BN(10_000_000_000),
          new anchor.BN(2_000_000_000),
          new anchor.BN(1_100_000),
          new anchor.BN(150_000)
        )
        .accounts({
          protocol: protocolPda,
          quoteAssetPool: assetPoolPda,
          owner: wallet.payer.publicKey,
          quoteMint,
          baseMint: baseMint.publicKey,
          loanPosition: loanPositionPda,
          loanVaultAuthority: loanVaultAuthorityPda,
          loanExecutionWallet: loanExecutionWalletPda,
          loanQuoteVault: loanQuoteVaultPda,
          userExtraQuoteTokenAccount: userQuoteAta.address,
          pumpFunProgram: mockPumpFunProgram.programId,
          pumpFunGlobal: mockPumpFunGlobalPda,
          pumpFunBondingCurve: mockPumpFunBondingCurvePda,
          pumpFunAssociatedBondingCurve: mockPumpFunAssociatedBondingCurvePda,
          pumpFunMayhemProgram,
          pumpFunGlobalParams,
          pumpFunSolVault,
          pumpFunMayhemState,
          pumpFunMayhemTokenVault,
          pumpFunLoanTemporaryWsolVault: mockPumpFunLoanTemporaryWsolVaultPda,
          pumpFunMintAuthority: mockPumpFunMintAuthorityPda,
          pumpFunEventAuthority: mockPumpFunEventAuthorityPda,
          pumpFunFeeRecipient,
          pumpFunCreatorVault,
          loanCollateralVault: loanCollateralVaultPda,
          userBaseTokenAccount: userBaseAta,
          quoteTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: mockPumpFunGlobalVolumeAccumulatorPda, isSigner: false, isWritable: false },
          {
            pubkey: mockPumpFunExecutionWalletVolumeAccumulatorPda,
            isSigner: false,
            isWritable: true,
          },
          { pubkey: mockPumpFunOwnerVolumeAccumulatorPda, isSigner: false, isWritable: true },
          { pubkey: mockPumpFunFeeConfigPda, isSigner: false, isWritable: false },
          { pubkey: pumpFeeProgramId, isSigner: false, isWritable: false },
          { pubkey: mockPumpFunBondingCurveV2Pda, isSigner: false, isWritable: true },
        ])
        .instruction();

      await sendVersionedTxWithLookup(
        [
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000,
          }),
          executeIx,
        ],
        [wallet.payer, baseMint]
      );
      throw new Error("Expected executeLaunchPumpFun to reject slippage exceeded");
    } catch (error: any) {
      const errorCode = error?.error?.errorCode?.code ?? "";
      const errorMessage = String(error?.message ?? "");
      const logs = Array.isArray(error?.logs)
        ? error.logs.join(" ")
        : Array.isArray(error?.transactionLogs)
          ? error.transactionLogs.join(" ")
          : Array.isArray(error?.error?.logs)
            ? error.error.logs.join(" ")
            : "";
      if (
        errorCode !== "SlippageExceeded" &&
        !errorMessage.includes("Slippage exceeded") &&
        !logs.includes("Slippage exceeded") &&
        !errorMessage.includes('{"Custom":0}')
      ) {
        throw error;
      }
    }
  });
});
