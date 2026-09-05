import { Keypair } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const dir = path.join(os.homedir(), ".config", "solana");
fs.mkdirSync(dir, { recursive: true });
const outFile = path.join(dir, "id.json");

if (fs.existsSync(outFile)) {
  const existing = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(outFile, "utf8"))),
  );
  console.log("Wallet already exists:", existing.publicKey.toBase58());
} else {
  const kp = Keypair.generate();
  fs.writeFileSync(outFile, JSON.stringify(Array.from(kp.secretKey)));
  console.log("Generated deploy wallet:", kp.publicKey.toBase58());
  console.log("Saved to:", outFile);
}
