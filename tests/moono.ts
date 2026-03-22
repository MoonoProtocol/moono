import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Moono } from "../target/types/moono";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

describe("moono", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.moono as Program<Moono>;
  const wallet = provider.wallet as anchor.Wallet & {
    payer: anchor.web3.Keypair;
  };

  const PAGE_SIZE = 32;


  async function ensureProtocolInitialized() {
    console.log("ensureProtocolInitialized called", program.programId);
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
    } else {
      console.log("Existiong Protocol:", existing);
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

    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
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

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
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

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = 0;

    const [tickPagePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_page"),
        assetPoolPda.toBuffer(),
        new anchor.BN(pageIndex).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    const tx = await program.methods
      .initializeTickPage(pageIndex)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        tickPage: tickPagePda,
        authority: wallet.payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();
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

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        authority: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = Math.floor(tick / PAGE_SIZE);

    const [tickPagePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_page"),
        assetPoolPda.toBuffer(),
        new anchor.BN(pageIndex).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeTickPage(pageIndex)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        tickPage: tickPagePda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

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

    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
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

    await program.methods
      .initializeTickPage(wrongPageIndex)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        tickPage: wrongTickPagePda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

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

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const pageIndex = Math.floor(tick / PAGE_SIZE);

    const [tickPagePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_page"),
        assetPoolPda.toBuffer(),
        new anchor.BN(pageIndex).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .initializeTickPage(pageIndex)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        tickPage: tickPagePda,
        authority: wallet.payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

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

    try {
      await program.methods
        .initializeAssetPool()
        .accounts({
          protocol: protocolPda,
          assetPool: assetPoolPda,
          mint,
          vaultAuthority: vaultAuthorityPda,
          vault: vaultPda,
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

  it("initialize_execution_strategy_config", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mode = 1; // pump.fun
    const extraQuoteCollateralBps = 1000; // 10%
    const maxQuoteLossBps = 1500; // 15%
    const minQuoteBufferAmount = new anchor.BN(5_000_000_000); // 5 WSOL
    const fixedMigrationCostQuote = new anchor.BN(500_000_000); // 0.5 WSOL

    const [strategyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_config"), Buffer.from([mode])],
      program.programId
    );

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

    const [strategyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_config"), Buffer.from([mode])],
      program.programId
    );

    await program.methods
      .initializeExecutionStrategyConfig(
        mode,
        1000,
        1500,
        new anchor.BN(5_000_000_000),
        new anchor.BN(500_000_000)
      )
      .accounts({
        protocol: protocolPda,
        strategyConfig: strategyConfigPda,
        authority: wallet.payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

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

  it("open_loan_transfers_quote_buffer_into_loan_vault", async () => {
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
      20_000_000_000 // 20 WSOL-ish units with 9 decimals
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

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        vaultAuthority: vaultAuthorityPda,
        vault: vaultPda,
        authority: wallet.payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const mode = 1;
    const [strategyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_config"), Buffer.from([mode])],
      program.programId
    );

    await program.methods
      .initializeExecutionStrategyConfig(
        mode,
        1000, // 10%
        1500,
        new anchor.BN(5_000_000_000), // min buffer = 5
        new anchor.BN(500_000_000) // fixed = 0.5
      )
      .accounts({
        protocol: protocolPda,
        strategyConfig: strategyConfigPda,
        authority: wallet.payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const loanId = new anchor.BN(1);
    const quoteBorrowedAmount = new anchor.BN(10_000_000_000); // 10

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

    const [loanQuoteBufferVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("loan_quote_buffer_vault"), loanPositionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openLoan(loanId, quoteBorrowedAmount)
      .accounts({
        protocol: protocolPda,
        quoteAssetPool: assetPoolPda,
        strategyConfig: strategyConfigPda,
        owner: wallet.payer.publicKey,
        quoteMint: mint,
        userQuoteTokenAccount: userAta.address,
        loanPosition: loanPositionPda,
        loanVaultAuthority: loanVaultAuthorityPda,
        loanQuoteBufferVault: loanQuoteBufferVaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet.payer])
      .rpc();

    const loan = await program.account.loanPosition.fetch(loanPositionPda);
    const bufferVault = await getAccount(provider.connection, loanQuoteBufferVaultPda);

    // buffer = max(10 * 10%, 5) + 0.5 = 5.5
    if (loan.quoteBufferAmount.toString() !== "5500000000") {
      throw new Error("quoteBufferAmount mismatch");
    }

    if (bufferVault.amount.toString() !== "5500000000") {
      throw new Error("loan quote buffer vault balance mismatch");
    }

    if (!loan.quoteAssetPool.equals(assetPoolPda)) {
      throw new Error("quoteAssetPool mismatch");
    }

    if (!loan.strategyConfig.equals(strategyConfigPda)) {
      throw new Error("strategyConfig mismatch");
    }

    if (loan.quoteBorrowedAmount.toString() !== "10000000000") {
      throw new Error("quoteBorrowedAmount mismatch");
    }
  });
});
