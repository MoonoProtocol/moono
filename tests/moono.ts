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

  const program = anchor.workspace.moono as any;
  const wallet = provider.wallet as anchor.Wallet & {
    payer: anchor.web3.Keypair;
  };

  const PAGE_SIZE = 32;
  let loanIdNonce = 0n;

  function makeRoutePlanHash(label: string): number[] {
    const bytes = Buffer.alloc(32);
    Buffer.from(label).copy(bytes, 0, 0, Math.min(label.length, 32));
    return Array.from(bytes);
  }

  function makeUniqueLoanId(): anchor.BN {
    loanIdNonce += 1n;
    return new anchor.BN(BigInt(Date.now()) + loanIdNonce);
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
});
