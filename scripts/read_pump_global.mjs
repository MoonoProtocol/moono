import * as anchor from "@coral-xyz/anchor";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const PUMP_PROGRAM_ID = new anchor.web3.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new anchor.web3.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_IDL_URL =
  "https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json";

async function main() {
  const response = await fetch(PUMP_IDL_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch pump IDL: ${response.status}`);
  }
  const idl = await response.json();
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const accountInfo = await connection.getAccountInfo(PUMP_GLOBAL, "confirmed");
  if (!accountInfo) {
    throw new Error("Pump global account not found");
  }

  const coder = new anchor.BorshAccountsCoder(idl);
  const decoded = coder.decode("Global", accountInfo.data);
  console.log(JSON.stringify(decoded, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
