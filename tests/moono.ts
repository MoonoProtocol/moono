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

});
