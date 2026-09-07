#!/usr/bin/env node
/**
 * Mission Control - Magic Actions failure diagnostic.
 *
 * verify-e2e.js showed that `commit_and_update_milestone` succeeds (a real,
 * confirmed ER transaction) but `milestone.high_value` never updates on
 * base layer even after 30s of polling, even with the action's escrow PDA
 * funded. A successful commit tx only proves the *commit* landed - per
 * MagicBlock's own docs, "scheduling or eventual commit success alone does
 * not prove that [a post-commit action] ran." This script looks at what
 * actually happened, from real on-chain data, instead of guessing:
 *
 *   1. Pulls the real commit transaction's logs from the ER it was sent to
 *      (devnet-as.magicblock.app) - this shows what the ER itself thought
 *      it scheduled.
 *   2. Pulls the *real* transaction history of the milestone PDA on base
 *      layer (rpc.magicblock.app/devnet) - if the post-commit action ever
 *      actually attempted to run, there will be a second signature here
 *      beyond the original `initialize`, and its logs will show either a
 *      program error (told to us directly) or a successful write.
 *   3. Compares the action escrow PDA's lamport balance now against what
 *      verify-e2e.js funded it to - if the delegation program ever
 *      attempted to charge the action's compute budget, lamports will have
 *      moved.
 *
 * No numbers here are invented - every field printed is either a live RPC
 * response or a literal explorer link so you can check it yourself.
 *
 * Usage (same directory/wallet as verify-e2e.js):
 *   node scripts/inspect-actions.js [commit-signature]
 *
 * If you omit the signature it defaults to the one from the last real run
 * (5AwmJG656PjncnFK3qiokKmbSXJ5KF1b31Bi3AtS3bMEQHJXeSuTztXNuxJdixxStf2T1umC4PujWjoLRCvxy5sL).
 * Pass a fresh one after re-running verify-e2e.js to check the latest attempt.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { escrowPdaFromEscrowAuthority } = require("@magicblock-labs/ephemeral-rollups-sdk");

const PROBE_ACTIONS_ID = new PublicKey("63pMnDypD8SVayKfXz1HbHjbQW1caX82UPRgsK4wSegh");
const SEED_ACTION_PROBE = Buffer.from("action_probe");
const SEED_MILESTONE = Buffer.from("milestone");

const BASE_LAYER_RPC = process.env.RPC_URL || "https://rpc.magicblock.app/devnet";
const ASIA_ER_RPC = "https://devnet-as.magicblock.app/";
const DEFAULT_SIG =
  "5AwmJG656PjncnFK3qiokKmbSXJ5KF1b31Bi3AtS3bMEQHJXeSuTztXNuxJdixxStf2T1umC4PujWjoLRCvxy5sL";

const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = (pk) => `https://explorer.solana.com/address/${pk.toBase58 ? pk.toBase58() : pk}?cluster=devnet`;

function actionProbePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_ACTION_PROBE, owner.toBuffer()], PROBE_ACTIONS_ID)[0];
}
function milestonePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_MILESTONE, owner.toBuffer()], PROBE_ACTIONS_ID)[0];
}

function printLogs(label, tx) {
  console.log(`\n--- ${label} ---`);
  if (!tx) {
    console.log("  (no transaction found - RPC returned null)");
    return;
  }
  console.log(`  slot: ${tx.slot}`);
  console.log(`  blockTime: ${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown"}`);
  console.log(`  err: ${tx.meta?.err ? JSON.stringify(tx.meta.err) : "none (tx itself succeeded)"}`);
  console.log(`  computeUnitsConsumed: ${tx.meta?.computeUnitsConsumed ?? "unknown"}`);
  console.log("  logMessages:");
  for (const line of tx.meta?.logMessages || []) console.log(`    ${line}`);
}

async function main() {
  const sig = process.argv[2] || DEFAULT_SIG;

  const walletPath = process.env.SOLANA_WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet found at ${walletPath}. Set SOLANA_WALLET if it's elsewhere.`);
    process.exit(1);
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const owner = Keypair.fromSecretKey(secret).publicKey;
  console.log("Wallet:", owner.toBase58(), " ", explorerAddr(owner));

  const pda = actionProbePda(owner);
  const mile = milestonePda(owner);
  const escrow = escrowPdaFromEscrowAuthority(owner, 255);
  console.log("Action probe PDA:", pda.toBase58());
  console.log("Milestone PDA:   ", mile.toBase58(), " ", explorerAddr(mile));
  console.log("Escrow PDA:      ", escrow.toBase58(), " ", explorerAddr(escrow));

  // 1. The commit tx itself, as the ER saw it.
  const erConn = new Connection(ASIA_ER_RPC, "confirmed");
  console.log(`\nFetching commit tx ${sig} from the ER it was sent to (${ASIA_ER_RPC})...`);
  let commitTx = null;
  try {
    commitTx = await erConn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  } catch (e) {
    console.log(`  ER fetch failed: ${e.message}`);
  }
  printLogs(`Commit tx on ER (${explorerTx(sig)})`, commitTx);

  // 2. Real tx history of the milestone PDA on base layer - the ground
  // truth for whether the post-commit action ever actually touched it.
  const baseConn = new Connection(BASE_LAYER_RPC, "confirmed");
  console.log(`\nFetching real signature history for the milestone PDA from base layer (${BASE_LAYER_RPC})...`);
  const sigs = await baseConn.getSignaturesForAddress(mile, { limit: 15 });
  console.log(`  ${sigs.length} signature(s) ever touched this account (newest first):`);
  for (const s of sigs) {
    console.log(`    ${s.signature}  slot=${s.slot}  err=${s.err ? JSON.stringify(s.err) : "none"}  ${explorerTx(s.signature)}`);
  }
  if (sigs.length <= 1) {
    console.log(
      "\n  => Only the original `initialize` (or none) ever touched the milestone account. " +
        "That means the post-commit action never even attempted to write to base layer - " +
        "it was dropped/never executed, not executed-and-reverted. Worth checking MagicBlock's " +
        "status API (https://status.magicblock.app/api/services, region 'asia', service 'er') " +
        "for the asia ER's action-execution health around this time.",
    );
  } else {
    console.log("\n  Fetching full logs for the newest non-initialize signature...");
    const target = sigs.find((s) => s.signature !== sigs[sigs.length - 1].signature) || sigs[0];
    const tx = await baseConn.getTransaction(target.signature, { maxSupportedTransactionVersion: 0 });
    printLogs(`Base-layer tx ${target.signature}`, tx);
  }

  // 3. Escrow balance now, for comparison against what verify-e2e.js funded.
  const escrowInfo = await baseConn.getAccountInfo(escrow);
  console.log(`\nEscrow PDA lamports now: ${escrowInfo ? escrowInfo.lamports : "account does not exist"}`);
  console.log(
    "  (verify-e2e.js top-up funds it to >=5,000,000 lamports if it was below that; if the " +
      "number here is meaningfully lower than what was funded, the delegation program did debit " +
      "it for a real attempt, even if that attempt then failed to write the milestone.)",
  );

  console.log("\nDone. Every line above is a real RPC response - paste this whole output back for the next step.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
