import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import { Moono } from "../target/types/moono";

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


  it("ping", async () => {
    const tx = await program.methods.ping().rpc();
    console.log("tx:", tx);
  });

  it("initialize_asset_pool", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        authority: provider.wallet.publicKey,
        system_program: anchor.web3.SystemProgram.programId
      })
      .rpc();
    console.log("tx:", tx);

    const assetPool = await program.account.assetPool.fetch(assetPoolPda);

    console.log("asset pool:", assetPool);

    if (!assetPool.protocol.equals(protocolPda)) {
      throw new Error("Protocol mismatch");
    }

    if (!assetPool.mint.equals(mint)) {
      throw new Error("Mint mismatch");
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
  });

  it("set_asset_pool_flags", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const tx = await program.methods
      .setAssetPoolFlags(false, false, true)
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
    console.log("tx:", tx);

    const assetPool = await program.account.assetPool.fetch(assetPoolPda);

    console.log("updated asset pool:", assetPool);

    if (assetPool.isEnabled !== false) {
      throw new Error("isEnabled should be false");
    }

    if (assetPool.allowDeposits !== false) {
      throw new Error("allowDeposits should be false");
    }

    if (assetPool.allowBorrows !== true) {
      throw new Error("allowBorrows should be true");
    }
  });

  it("initialize_tick_page", async () => {
    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
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
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("tx:", tx);

    const page = await program.account.tickPage.fetch(tickPagePda);

    if (page.pageIndex !== pageIndex) {
      throw new Error("Wrong page index");
    }
  });


  it("mock_deposit_to_tick", async () => {
    const tick = 10;
    const amount = new anchor.BN(1000);

    const res = await ensureProtocolInitialized();
    const protocolPda = res[0];

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const [assetPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset_pool"), mint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeAssetPool()
      .accounts({
        protocol: protocolPda,
        assetPool: assetPoolPda,
        mint,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
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
      .rpc();

    const tx = await program.methods
      .mockDepositToTick(tick, amount)
      .accounts({
        tickPage: tickPagePda,
        assetPool: assetPoolPda,
      })
      .rpc();
    console.log("tx:", tx);

    const page = await program.account.tickPage.fetch(tickPagePda);
    const index = tick % PAGE_SIZE;

    if (page.ticks[index].availableLiquidity.toNumber() !== 1000) {
      throw new Error("Wrong liquidity");
    }

    if (page.ticks[index].totalShares.toNumber() !== 1000) {
      throw new Error("Wrong shares");
    }

    if (page.nonEmptyBitmap.toNumber() === 0) {
      throw new Error("Bitmap not updated");
    }
  });

});
