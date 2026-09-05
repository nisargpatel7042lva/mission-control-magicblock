import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const programs = [
  "probe-core",
  "probe-vrf",
  "probe-actions",
  "probe-crank",
  "probe-oracle",
  "probe-session",
];

const outDir = path.resolve("../target/deploy");
fs.mkdirSync(outDir, { recursive: true });

const summary = {};
for (const name of programs) {
  const kp = Keypair.generate();
  const outFile = path.join(outDir, `${name}-keypair.json`);
  fs.writeFileSync(outFile, JSON.stringify(Array.from(kp.secretKey)));
  summary[name] = kp.publicKey.toBase58();
  console.log(`${name}: ${kp.publicKey.toBase58()}`);
}

fs.writeFileSync(
  path.resolve("./program-ids.json"),
  JSON.stringify(summary, null, 2),
);
