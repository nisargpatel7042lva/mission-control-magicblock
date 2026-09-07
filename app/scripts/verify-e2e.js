#!/usr/bin/env node
/**
 * Mission Control - real, end-to-end devnet verification.
 *
 * This is NOT a simulation and it does not print any invented numbers.
 * Every timing, slot, price, and count below comes from an actual
 * confirmed devnet transaction or a real `.fetch()` of on-chain account
 * data, made with the exact same account shapes the dashboard itself uses
 * (mirrored line-for-line from app/components/probes/*.tsx and app/lib/*.ts
 * so this script can't silently drift from what a real user's browser
 * actually sends). Every transaction signature printed is independently
 * checkable on Solana's own devnet explorer - that's the "source" for
 * every number this script reports.
 *
 * Run this from your own terminal (WSL / Git Bash / native shell) with
 * real devnet network access - NOT through any Claude-driven tool.
 *
 *   cd app
 *   npm install        # only needed once
 *   node scripts/verify-e2e.js
 *
 * It uses the same wallet as your deploy (~/.config/solana/id.json) and
 * needs a small amount of devnet SOL (a fraction of a SOL covers rent for
 * a handful of small test accounts + tx fees + one 0.005 SOL session
 * top-up + one 0.01 SOL escrow top-up). It writes two files next to itself
 * when done:
 *   - verify-results.json     raw machine-readable results
 *   - VERIFICATION-RESULTS.md human-readable report with explorer links
 *
 * Every probe runs independently in its own try/catch - one probe failing
 * does not stop the others, and every failure is reported with the real
 * error message, not swallowed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { AnchorProvider, Program, BN, Wallet } = require("@coral-xyz/anchor");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");
const {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  escrowPdaFromEscrowAuthority,
  createTopUpEscrowInstruction,
} = require("@magicblock-labs/ephemeral-rollups-sdk");

// ---------------------------------------------------------------------------
// IDLs - the exact same JSON files the dashboard imports.
// ---------------------------------------------------------------------------
const probeCoreIdl = require("../lib/idl/probe_core.json");
const probeVrfIdl = require("../lib/idl/probe_vrf.json");
const probeActionsIdl = require("../lib/idl/probe_actions.json");
const probeCrankIdl = require("../lib/idl/probe_crank.json");
const probeOracleIdl = require("../lib/idl/probe_oracle.json");
const probeSessionIdl = require("../lib/idl/probe_session.json");

// ---------------------------------------------------------------------------
// Constants mirrored from app/lib/*.ts (kept in sync with those files, not
// re-derived, so this script fails the same way the dashboard would rather
// than silently testing something different).
// ---------------------------------------------------------------------------
const PROBE_CORE_ID = new PublicKey("96ru2VBdLyqvtvVTwgAKs9e4k8DVqpero5dHvXTVkfEA");
const PROBE_VRF_ID = new PublicKey("EzQLQDFAapDwyHnPsv9PUnt4mEbrLPfgnpBJmeu766fT");
const PROBE_ACTIONS_ID = new PublicKey("63pMnDypD8SVayKfXz1HbHjbQW1caX82UPRgsK4wSegh");
const PROBE_CRANK_ID = new PublicKey("gzNGTCNmCBfxGJL5t5XExoeHsB9ooc4LUubZ41Po86K");
const PROBE_ORACLE_ID = new PublicKey("ELzCkEvf5EV6KVAQgvbuGyLZ9TJrfzvdCejKs6n85EPW");
const PROBE_SESSION_ID = new PublicKey("UxGyQjXVBWXRwocPs1sjhV2BLWRmjwPc93yGVEn4XHd");

const GPL_SESSION_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const SESSION_TOKEN_V2_SEED = Buffer.from("session_token_v2");

const SEED_CORE_PROBE = Buffer.from("probe");
const SEED_VRF_PROBE = Buffer.from("vrf_probe");
const SEED_ACTION_PROBE = Buffer.from("action_probe");
const SEED_MILESTONE = Buffer.from("milestone");
const SEED_CRANK_PROBE = Buffer.from("crank_probe");
const SEED_ORACLE_PROBE = Buffer.from("oracle_probe");
const SEED_SESSION_PROBE = Buffer.from("session_probe");

const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");

// Real devnet fixtures from MagicBlock's own magicblock-engine-examples repo
// (oracle-priced-purchase/anchor/tests) - not invented. Tried in order; the
// code comment in oracle-fixtures.ts already flags these could rotate.
function feedIdFromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
const ORACLE_FIXTURES = [
  {
    label: "SOL/USD (fixture @ $100)",
    priceUpdate: new PublicKey("B8vx8v7SwZsmFYz3fkSJphr7uq34LoiVr18pimLG5FJM"),
    feedId: feedIdFromHex("969cefe5a1c3dc424aeaf191893d642799b8545431b5e2560e1cc78ccfdd91d6".slice(0, 64)),
  },
  {
    label: "SOL/USD (fixture @ $50)",
    priceUpdate: new PublicKey("EpdAP2KHQAXPccREjM1WsLiyKVcchYj82pv9sWZhYUY1"),
    feedId: feedIdFromHex("cd5b1dc2e5486ee8a1fa93a76ad56a1d15fef45c54fac50c7b489f1f3be0136a".slice(0, 64)),
  },
];

const BASE_LAYER_RPC = process.env.RPC_URL || "https://rpc.magicblock.app/devnet";
const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
const ASIA_ER_RPC = "https://devnet-as.magicblock.app/";

function toLabel16(label) {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(label).slice(0, 16));
  return out;
}
const CORE_LABEL = toLabel16("verify-e2e");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = (pk) => `https://explorer.solana.com/address/${pk.toBase58 ? pk.toBase58() : pk}?cluster=devnet`;

async function timeIt(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

function coreProbePda(owner, label) {
  return PublicKey.findProgramAddressSync([SEED_CORE_PROBE, owner.toBuffer(), Buffer.from(label)], PROBE_CORE_ID)[0];
}
function vrfProbePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_VRF_PROBE, owner.toBuffer()], PROBE_VRF_ID)[0];
}
function vrfProgramIdentityPda(callingProgram) {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], callingProgram)[0];
}
function actionProbePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_ACTION_PROBE, owner.toBuffer()], PROBE_ACTIONS_ID)[0];
}
function milestonePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_MILESTONE, owner.toBuffer()], PROBE_ACTIONS_ID)[0];
}
function crankProbePda(owner) {
  return PublicKey.findProgramAddressSync([SEED_CRANK_PROBE, owner.toBuffer()], PROBE_CRANK_ID)[0];
}
function oracleProbePda(owner, feedId) {
  return PublicKey.findProgramAddressSync([SEED_ORACLE_PROBE, owner.toBuffer(), Buffer.from(feedId)], PROBE_ORACLE_ID)[0];
}
function sessionProbePda(authority) {
  return PublicKey.findProgramAddressSync([SEED_SESSION_PROBE, authority.toBuffer()], PROBE_SESSION_ID)[0];
}
function sessionTokenV2Pda(targetProgram, sessionSigner, authority) {
  return PublicKey.findProgramAddressSync(
    [SESSION_TOKEN_V2_SEED, targetProgram.toBuffer(), sessionSigner.toBuffer(), authority.toBuffer()],
    GPL_SESSION_PROGRAM_ID,
  )[0];
}

function delegateAccounts(probePda, ownerProgramId) {
  return {
    bufferPda: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(probePda, ownerProgramId),
    delegationRecordPda: delegationRecordPdaFromDelegatedAccount(probePda),
    delegationMetadataPda: delegationMetadataPdaFromDelegatedAccount(probePda),
    ownerProgram: ownerProgramId,
    delegationProgram: DELEGATION_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}
function commitAccounts() {
  return { magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID };
}

/** Is `pda`'s actual Solana account owner currently the Delegation Program? */
async function isDelegated(connection, pda) {
  const info = await connection.getAccountInfo(pda);
  if (!info) return { exists: false, delegated: false };
  return { exists: true, delegated: info.owner.equals(DELEGATION_PROGRAM_ID) };
}

const GPL_SESSION_IDL = {
  address: GPL_SESSION_PROGRAM_ID.toBase58(),
  metadata: { name: "gpl_session", version: "3.1.1", spec: "0.1.0" },
  instructions: [
    {
      name: "create_session_v2",
      discriminator: [223, 233, 108, 7, 65, 194, 235, 38],
      accounts: [
        { name: "session_token", writable: true },
        { name: "session_signer", writable: true, signer: true },
        { name: "fee_payer", writable: true, signer: true },
        { name: "authority", signer: true },
        { name: "target_program" },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "top_up", type: { option: "bool" } },
        { name: "valid_until", type: { option: "i64" } },
        { name: "lamports", type: { option: "u64" } },
      ],
    },
  ],
  accounts: [{ name: "SessionTokenV2", discriminator: [178, 3, 85, 254, 13, 116, 128, 41] }],
  types: [
    {
      name: "SessionTokenV2",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "target_program", type: "pubkey" },
          { name: "session_signer", type: "pubkey" },
          { name: "fee_payer", type: "pubkey" },
          { name: "valid_until", type: "i64" },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const report = []; // { probe, step, ok, ms, signature, note }
const results = {}; // raw structured data per probe, dumped to JSON

function logStep(probe, step, ok, extra) {
  const line = { probe, step, ok, ...extra };
  report.push(line);
  const tag = ok ? "OK  " : "FAIL";
  const ms = extra?.ms !== undefined ? ` (${extra.ms}ms)` : "";
  const sig = extra?.signature ? `  ${explorerTx(extra.signature)}` : "";
  const note = extra?.note ? `  - ${extra.note}` : "";
  console.log(`[${tag}] ${probe}: ${step}${ms}${sig}${note}`);
}

// ===========================================================================
async function main() {
  console.log("=== Mission Control - real devnet end-to-end verification ===");
  console.log(new Date().toISOString());

  const walletPath = process.env.SOLANA_WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet found at ${walletPath}. Run the deploy script first, or set SOLANA_WALLET.`);
    process.exit(1);
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const keypair = Keypair.fromSecretKey(secret);
  const wallet = new Wallet(keypair);
  console.log("Wallet:", wallet.publicKey.toBase58(), " ", explorerAddr(wallet.publicKey));

  const baseConnection = new Connection(BASE_LAYER_RPC, "confirmed");
  const airdropConnection = new Connection(PUBLIC_DEVNET_RPC, "confirmed");

  let balance = await baseConnection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(6)} SOL (real, fetched from ${BASE_LAYER_RPC})`);
  if (balance < 0.3 * 1e9) {
    console.log("Balance looks low for this test suite - attempting a devnet airdrop (best-effort)...");
    try {
      const sig = await airdropConnection.requestAirdrop(wallet.publicKey, 1 * 1e9);
      await airdropConnection.confirmTransaction(sig, "confirmed");
      balance = await baseConnection.getBalance(wallet.publicKey);
      console.log(`Airdrop landed. New balance: ${(balance / 1e9).toFixed(6)} SOL  ${explorerTx(sig)}`);
    } catch (e) {
      console.log(`Airdrop failed/rate-limited (${e.message}). Continuing with existing balance - top up manually at https://faucet.solana.com if steps below fail on insufficient funds.`);
    }
  }

  const baseProvider = new AnchorProvider(baseConnection, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const programs = {
    core: new Program(probeCoreIdl, baseProvider),
    vrf: new Program(probeVrfIdl, baseProvider),
    actions: new Program(probeActionsIdl, baseProvider),
    crank: new Program(probeCrankIdl, baseProvider),
    oracle: new Program(probeOracleIdl, baseProvider),
    session: new Program(probeSessionIdl, baseProvider),
    gplSession: new Program(GPL_SESSION_IDL, baseProvider),
  };

  function erProgram(idl, erRpc) {
    const conn = new Connection(erRpc, "confirmed");
    const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
    return { program: new Program(idl, provider), connection: conn };
  }

  await runCore(baseConnection, programs);
  await runVrf(baseConnection, programs);
  await runActions(baseConnection, programs);
  await runCrank(baseConnection, programs);
  await runOracle(programs);
  await runSession(baseConnection, programs, wallet);

  // -------------------------------------------------------------------------
  const outDir = __dirname;
  fs.writeFileSync(path.join(outDir, "verify-results.json"), JSON.stringify({ wallet: wallet.publicKey.toBase58(), generatedAt: new Date().toISOString(), report, results }, null, 2));

  const md = buildMarkdown(wallet.publicKey.toBase58());
  fs.writeFileSync(path.join(outDir, "VERIFICATION-RESULTS.md"), md);

  console.log("\n=== Done ===");
  const failed = report.filter((r) => !r.ok);
  console.log(`${report.length} steps run, ${failed.length} failed.`);
  console.log("Wrote scripts/verify-results.json and scripts/VERIFICATION-RESULTS.md");
  if (failed.length > 0) {
    console.log("\nFailed steps:");
    for (const f of failed) console.log(`  - ${f.probe}: ${f.step} - ${f.note || ""}`);
    process.exitCode = 1;
  }

  // helper used above, defined here to close over `erProgram`
  function erProgramRef() {} // no-op, keeps erProgram referenced for linters
  void erProgramRef;

  async function runCore(conn, programs) {
    const P = "Core";
    try {
      const owner = wallet.publicKey;
      const pda = coreProbePda(owner, CORE_LABEL);
      results.core = { probePda: pda.toBase58() };

      const { ms: initMs, result: initSig } = await timeIt(() =>
        programs.core.methods.initialize(Array.from(CORE_LABEL)).accounts({ user: owner, systemProgram: SystemProgram.programId }).rpc(),
      );
      logStep(P, "initialize", true, { ms: initMs, signature: initSig });
      results.core.initSig = initSig;

      let { delegated } = await isDelegated(conn, pda);

      if (!delegated) {
        const { ms, result: sig } = await timeIt(() =>
          programs.core.methods.ping().accounts({ probe: pda }).rpc(),
        );
        logStep(P, "ping (base layer, real Solana slot)", true, { ms, signature: sig });
        results.core.baseLayerPingMs = ms;
        results.core.baseLayerPingSig = sig;
      } else {
        logStep(P, "ping (base layer)", true, { note: "skipped - probe is already delegated from a prior run" });
      }

      if (!delegated) {
        const acc = delegateAccounts(pda, PROBE_CORE_ID);
        const { ms, result: sig } = await timeIt(() =>
          programs.core.methods.delegate().accounts({ payer: owner, pda, ...acc }).rpc(),
        );
        logStep(P, "delegate -> asia ER", true, { ms, signature: sig });
        results.core.delegateSig = sig;
        delegated = true;
      } else {
        logStep(P, "delegate", true, { note: "already delegated" });
      }

      const { program: erCore } = erProgram(probeCoreIdl, ASIA_ER_RPC);
      const erPingSamples = [];
      for (let i = 0; i < 3; i++) {
        const { ms, result: sig } = await timeIt(() => erCore.methods.ping().accounts({ probe: pda }).rpc());
        logStep(P, `ping (asia ER, sample ${i + 1}/3)`, true, { ms, signature: sig });
        erPingSamples.push({ ms, signature: sig });
      }
      results.core.erPingSamples = erPingSamples;
      const avgEr = erPingSamples.reduce((a, s) => a + s.ms, 0) / erPingSamples.length;
      results.core.erPingAvgMs = Math.round(avgEr);
      if (results.core.baseLayerPingMs) {
        results.core.speedupFactor = Number((results.core.baseLayerPingMs / avgEr).toFixed(2));
        logStep(P, "computed speedup (real base-layer ms / real avg ER ms)", true, {
          note: `${results.core.baseLayerPingMs}ms / ${avgEr.toFixed(1)}ms = ${results.core.speedupFactor}x`,
        });
      }

      const commitAcc = commitAccounts();
      const { ms: commitMs, result: commitSig } = await timeIt(() =>
        erCore.methods.commit().accounts({ payer: owner, probe: pda, ...commitAcc }).rpc(),
      );
      logStep(P, "commit (asia ER)", true, { ms: commitMs, signature: commitSig });
      results.core.commitSig = commitSig;

      const { ms: undelMs, result: undelSig } = await timeIt(() =>
        erCore.methods.undelegate().accounts({ payer: owner, probe: pda, ...commitAcc }).rpc(),
      );
      logStep(P, "undelegate (asia ER)", true, { ms: undelMs, signature: undelSig });
      results.core.undelegateSig = undelSig;

      const finalAccount = await programs.core.account.probe.fetch(pda);
      results.core.finalPingCount = finalAccount.pingCount.toString();
      logStep(P, "final state read (base layer, post-undelegate)", true, {
        note: `ping_count=${finalAccount.pingCount.toString()} last_value=${finalAccount.lastValue.toString()}`,
      });
    } catch (e) {
      logStep(P, "unhandled error", false, { note: e.message || String(e) });
      results.core = { ...(results.core || {}), error: e.message || String(e) };
    }
  }

  async function runVrf(conn, programs) {
    const P = "VRF";
    try {
      const owner = wallet.publicKey;
      const pda = vrfProbePda(owner);
      const programIdentity = vrfProgramIdentityPda(PROBE_VRF_ID);
      results.vrf = { probePda: pda.toBase58() };

      const { ms: initMs, result: initSig } = await timeIt(() =>
        programs.vrf.methods.initialize().accounts({ payer: owner, systemProgram: SystemProgram.programId }).rpc(),
      );
      logStep(P, "initialize", true, { ms: initMs, signature: initSig });
      results.vrf.initSig = initSig;

      let account = await programs.vrf.account.vrfProbe.fetch(pda);
      if (account.status === 1) {
        logStep(P, "waiting out a request already in-flight from a prior run", true, { note: "cannot request again until it resolves" });
        for (let i = 0; i < 30 && account.status === 1; i++) {
          await sleep(2000);
          account = await programs.vrf.account.vrfProbe.fetch(pda);
        }
      }

      const clientSeed = Math.floor(Math.random() * 255);
      const { ms: reqMs, result: reqSig } = await timeIt(() =>
        programs.vrf.methods
          .requestRandomness(clientSeed)
          .accounts({
            payer: owner,
            probe: pda,
            oracleQueue: DEFAULT_QUEUE,
            programIdentity,
            vrfProgram: VRF_PROGRAM_ID,
            slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      );
      logStep(P, "request_randomness (base layer, DEFAULT_QUEUE)", true, { ms: reqMs, signature: reqSig });
      results.vrf.requestSig = reqSig;

      account = await programs.vrf.account.vrfProbe.fetch(pda);
      results.vrf.requestedAtSlot = account.requestedAtSlot.toString();

      const pollStart = Date.now();
      const timeoutMs = 90_000;
      let fulfilled = false;
      while (Date.now() - pollStart < timeoutMs) {
        await sleep(2000);
        account = await programs.vrf.account.vrfProbe.fetch(pda);
        if (account.status === 2) {
          fulfilled = true;
          break;
        }
      }
      const elapsedMs = Date.now() - pollStart;

      if (fulfilled) {
        results.vrf.fulfilledAtSlot = account.fulfilledAtSlot.toString();
        results.vrf.fulfillmentLatencyMs = elapsedMs;
        results.vrf.lastResult = account.lastResult;
        results.vrf.slotDelta = (BigInt(account.fulfilledAtSlot.toString()) - BigInt(account.requestedAtSlot.toString())).toString();
        logStep(P, "oracle callback (consume_randomness) observed", true, {
          note: `fulfilled after ${elapsedMs}ms real wall-clock polling, ${results.vrf.slotDelta} real slots, result=${account.lastResult}`,
        });
      } else {
        results.vrf.fulfillmentLatencyMs = null;
        results.vrf.timedOutAfterMs = elapsedMs;
        logStep(P, "oracle callback (consume_randomness)", false, {
          note: `did not observe fulfillment within ${timeoutMs}ms of real polling - the request tx above landed, but the devnet VRF oracle service had not called back by the time this script gave up. Check https://status.magicblock.app and the request tx for details before assuming this is a bug in the program.`,
        });
      }
    } catch (e) {
      logStep(P, "unhandled error", false, { note: e.message || String(e) });
      results.vrf = { ...(results.vrf || {}), error: e.message || String(e) };
    }
  }

  async function runActions(conn, programs) {
    const P = "Actions";
    try {
      const owner = wallet.publicKey;
      const pda = actionProbePda(owner);
      const mile = milestonePda(owner);
      results.actions = { probePda: pda.toBase58(), milestonePda: mile.toBase58() };

      const { ms: initMs, result: initSig } = await timeIt(() =>
        programs.actions.methods.initialize().accounts({ user: owner, probe: pda, milestone: mile, systemProgram: SystemProgram.programId }).rpc(),
      );
      logStep(P, "initialize", true, { ms: initMs, signature: initSig });
      results.actions.initSig = initSig;

      const milestoneBefore = await programs.actions.account.milestone.fetch(mile);
      results.actions.highValueBefore = milestoneBefore.highValue.toString();

      let { delegated } = await isDelegated(conn, pda);
      if (!delegated) {
        const acc = delegateAccounts(pda, PROBE_ACTIONS_ID);
        const { ms, result: sig } = await timeIt(() =>
          programs.actions.methods.delegate().accounts({ payer: owner, pda, ...acc }).rpc(),
        );
        logStep(P, "delegate -> asia ER", true, { ms, signature: sig });
        results.actions.delegateSig = sig;
      } else {
        logStep(P, "delegate", true, { note: "already delegated" });
      }

      const { program: erActions } = erProgram(probeActionsIdl, ASIA_ER_RPC);
      const { ms: pingMs, result: pingSig } = await timeIt(() => erActions.methods.ping().accounts({ probe: pda }).rpc());
      logStep(P, "ping (asia ER)", true, { ms: pingMs, signature: pingSig });
      results.actions.pingSig = pingSig;

      // The post-commit "update_milestone" action is authenticated via an
      // escrow PDA (`ephemeral_balance_pda_from_payer(escrow_auth, 255)`)
      // that only the delegation program can sign for - real MagicBlock
      // security model, see programs/probe-actions/src/lib.rs. Nothing in
      // the current dashboard UI ever creates/funds that escrow account, so
      // without this step the action likely never actually lands even
      // though "commit + schedule milestone update" reports success. This
      // script funds it for real so we can find out, on real devnet, which
      // of those two things is actually true.
      const escrow = escrowPdaFromEscrowAuthority(owner, 255);
      const escrowInfo = await conn.getAccountInfo(escrow);
      const escrowLamports = escrowInfo?.lamports || 0;
      results.actions.escrowPda = escrow.toBase58();
      results.actions.escrowLamportsBefore = escrowLamports;
      if (escrowLamports < 5_000_000) {
        const topUpIx = createTopUpEscrowInstruction(escrow, owner, owner, 10_000_000, 255);
        const tx = new Transaction().add(topUpIx);
        const { ms, result: sig } = await timeIt(() => baseProvider.sendAndConfirm(tx, []));
        logStep(P, "top up escrow (real fix: dashboard UI never does this)", true, { ms, signature: sig, note: "funded 0.01 SOL to the escrow PDA the post-commit action needs" });
        results.actions.escrowTopUpSig = sig;
      } else {
        logStep(P, "top up escrow", true, { note: "already funded from a prior run" });
      }

      const commitAcc = commitAccounts();
      const { ms: caMs, result: caSig } = await timeIt(() =>
        erActions.methods
          .commitAndUpdateMilestone()
          .accounts({ payer: owner, probe: pda, milestone: mile, programId: PROBE_ACTIONS_ID, ...commitAcc })
          .rpc(),
      );
      logStep(P, "commit + schedule milestone update (asia ER)", true, { ms: caMs, signature: caSig });
      results.actions.commitAndUpdateSig = caSig;

      // Milestone lives on base layer and updates asynchronously once the
      // network actually runs the scheduled post-commit action - poll for
      // real, don't assume.
      const pollStart = Date.now();
      let milestoneAfter = milestoneBefore;
      let updated = false;
      while (Date.now() - pollStart < 30_000) {
        await sleep(2000);
        milestoneAfter = await programs.actions.account.milestone.fetch(mile);
        if (milestoneAfter.highValue.toString() !== milestoneBefore.highValue.toString()) {
          updated = true;
          break;
        }
      }
      const elapsed = Date.now() - pollStart;
      results.actions.highValueAfter = milestoneAfter.highValue.toString();
      results.actions.milestoneUpdateLatencyMs = updated ? elapsed : null;
      if (updated) {
        logStep(P, "milestone updated on base layer (async post-commit action)", true, {
          note: `high_value ${milestoneBefore.highValue.toString()} -> ${milestoneAfter.highValue.toString()} after ${elapsed}ms real polling`,
        });
      } else {
        logStep(P, "milestone update on base layer", false, {
          note: `high_value still ${milestoneAfter.highValue.toString()} after ${elapsed}ms - the post-commit action did not land within the poll window even with the escrow funded. Worth a manual look at the commit tx logs above.`,
        });
      }

      const { ms: undelMs, result: undelSig } = await timeIt(() =>
        erActions.methods.undelegate().accounts({ payer: owner, probe: pda, ...commitAcc }).rpc(),
      );
      logStep(P, "undelegate (asia ER)", true, { ms: undelMs, signature: undelSig });
      results.actions.undelegateSig = undelSig;
    } catch (e) {
      logStep(P, "unhandled error", false, { note: e.message || String(e) });
      results.actions = { ...(results.actions || {}), error: e.message || String(e) };
    }
  }

  async function runCrank(conn, programs) {
    const P = "Crank";
    try {
      const owner = wallet.publicKey;
      const pda = crankProbePda(owner);
      results.crank = { probePda: pda.toBase58() };

      const { ms: initMs, result: initSig } = await timeIt(() =>
        programs.crank.methods.initialize().accounts({ user: owner, systemProgram: SystemProgram.programId }).rpc(),
      );
      logStep(P, "initialize", true, { ms: initMs, signature: initSig });
      results.crank.initSig = initSig;

      let { delegated } = await isDelegated(conn, pda);
      if (!delegated) {
        const acc = delegateAccounts(pda, PROBE_CRANK_ID);
        const { ms, result: sig } = await timeIt(() =>
          programs.crank.methods.delegate().accounts({ payer: owner, pda, ...acc }).rpc(),
        );
        logStep(P, "delegate -> asia ER", true, { ms, signature: sig });
        results.crank.delegateSig = sig;
      } else {
        logStep(P, "delegate", true, { note: "already delegated" });
      }

      const { program: erCrank } = erProgram(probeCrankIdl, ASIA_ER_RPC);
      const before = await erCrank.account.crankProbe.fetch(pda);
      results.crank.countBefore = before.count.toString();

      const taskId = new BN(Date.now());
      const { ms: schedMs, result: schedSig } = await timeIt(() =>
        erCrank.methods
          .schedulePing({ taskId, executionIntervalMillis: new BN(1000), iterations: new BN(5) })
          .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: owner, probe: pda, program: PROBE_CRANK_ID })
          .rpc(),
      );
      logStep(P, "schedule crank (5x / 1s, asia ER)", true, { ms: schedMs, signature: schedSig, note: "acceptance only - does not mean it ran yet" });
      results.crank.scheduleSig = schedSig;

      const scheduleTime = Date.now();
      const timeline = [];
      let lastCount = before.count.toString();
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const acct = await erCrank.account.crankProbe.fetch(pda);
        const count = acct.count.toString();
        timeline.push({ tSinceScheduleMs: Date.now() - scheduleTime, count });
        if (count !== lastCount) {
          logStep(P, `observed applied count -> ${count}`, true, { note: `${Date.now() - scheduleTime}ms after schedule tx` });
          lastCount = count;
        }
      }
      results.crank.observedTimeline = timeline;
      results.crank.countAfter = lastCount;
      const applied = BigInt(lastCount) - BigInt(before.count.toString());
      logStep(P, "crank result", applied > 0n, {
        note: `requested 5 iterations, observed ${applied} real applied increments over the poll window (count ${before.count.toString()} -> ${lastCount})`,
      });

      const commitAcc = commitAccounts();
      const { ms: undelMs, result: undelSig } = await timeIt(() =>
        erCrank.methods.undelegate().accounts({ payer: owner, probe: pda, ...commitAcc }).rpc(),
      );
      logStep(P, "undelegate (asia ER)", true, { ms: undelMs, signature: undelSig });
      results.crank.undelegateSig = undelSig;
    } catch (e) {
      logStep(P, "unhandled error", false, { note: e.message || String(e) });
      results.crank = { ...(results.crank || {}), error: e.message || String(e) };
    }
  }

  async function runOracle(programs) {
    const P = "Oracle";
    results.oracle = {};
    for (const fixture of ORACLE_FIXTURES) {
      try {
        const owner = wallet.publicKey;
        const pda = oracleProbePda(owner, fixture.feedId);

        const { ms: initMs, result: initSig } = await timeIt(() =>
          programs.oracle.methods.initialize(Array.from(fixture.feedId)).accounts({ user: owner, systemProgram: SystemProgram.programId }).rpc(),
        );
        logStep(P, `initialize (${fixture.label})`, true, { ms: initMs, signature: initSig });

        const { ms: obsMs, result: obsSig } = await timeIt(() =>
          programs.oracle.methods.observePrice().accounts({ probe: pda, priceUpdate: fixture.priceUpdate }).rpc(),
        );
        const account = await programs.oracle.account.priceProbe.fetch(pda);
        const price = Number(account.lastPrice.toString()) * Math.pow(10, account.lastExponent);
        const ageSeconds = Math.floor(Date.now() / 1000 - account.lastPublishTime.toNumber());
        logStep(P, `observe_price (${fixture.label})`, true, {
          ms: obsMs,
          signature: obsSig,
          note: `price=${price.toFixed(4)} publish_time=${account.lastPublishTime.toString()} age=${ageSeconds}s observations=${account.observationCount.toString()}`,
        });
        results.oracle[fixture.label] = {
          probePda: pda.toBase58(),
          initSig,
          observeSig: obsSig,
          price,
          lastPublishTime: account.lastPublishTime.toString(),
          ageSecondsAtCheck: ageSeconds,
          observationCount: account.observationCount.toString(),
        };
        return; // first fixture that works is enough - stop here
      } catch (e) {
        logStep(P, `observe_price (${fixture.label})`, false, { note: e.message || String(e) });
        results.oracle[fixture.label] = { error: e.message || String(e) };
      }
    }
  }

  async function runSession(conn, programs, wallet) {
    const P = "Session";
    try {
      const owner = wallet.publicKey;
      const pda = sessionProbePda(owner);
      results.session = { probePda: pda.toBase58() };

      const { ms: initMs, result: initSig } = await timeIt(() =>
        programs.session.methods.initialize().accounts({ user: owner, systemProgram: SystemProgram.programId }).rpc(),
      );
      logStep(P, "initialize", true, { ms: initMs, signature: initSig });
      results.session.initSig = initSig;

      let { delegated } = await isDelegated(conn, pda);
      if (!delegated) {
        const acc = delegateAccounts(pda, PROBE_SESSION_ID);
        const { ms, result: sig } = await timeIt(() =>
          programs.session.methods.delegate().accounts({ payer: owner, pda, sessionToken: null, ...acc }).rpc(),
        );
        logStep(P, "delegate -> asia ER", true, { ms, signature: sig });
        results.session.delegateSig = sig;
      } else {
        logStep(P, "delegate", true, { note: "already delegated" });
      }

      const { program: erSession, connection: erConn } = erProgram(probeSessionIdl, ASIA_ER_RPC);

      const { ms: walletPingMs, result: walletPingSig } = await timeIt(() =>
        erSession.methods.ping().accounts({ payer: owner, probe: pda, sessionToken: null }).rpc(),
      );
      logStep(P, "ping via wallet (1 signature)", true, { ms: walletPingMs, signature: walletPingSig });
      results.session.walletPingMs = walletPingMs;
      results.session.walletPingSig = walletPingSig;

      const sessionKp = Keypair.generate();
      const tokenPda = sessionTokenV2Pda(PROBE_SESSION_ID, sessionKp.publicKey, owner);
      const { ms: createMs, result: createSig } = await timeIt(() =>
        programs.gplSession.methods
          .createSessionV2(true, null, new BN(5_000_000))
          .accounts({
            sessionToken: tokenPda,
            sessionSigner: sessionKp.publicKey,
            feePayer: owner,
            authority: owner,
            targetProgram: PROBE_SESSION_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([sessionKp])
          .rpc(),
      );
      logStep(P, "create session (1 wallet signature, tops up 0.005 SOL)", true, { ms: createMs, signature: createSig });
      results.session.createSessionSig = createSig;

      const sessionPingSamples = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const ix = await erSession.methods.ping().accounts({ payer: sessionKp.publicKey, probe: pda, sessionToken: tokenPda }).instruction();
        const tx = new Transaction().add(ix);
        tx.feePayer = sessionKp.publicKey;
        const { blockhash } = await erConn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(sessionKp);
        const sig = await erConn.sendRawTransaction(tx.serialize());
        await erConn.confirmTransaction(sig, "confirmed");
        const ms = Date.now() - t0;
        logStep(P, `ping via session, no popup (sample ${i + 1}/3)`, true, { ms, signature: sig });
        sessionPingSamples.push({ ms, signature: sig });
      }
      results.session.sessionPingSamples = sessionPingSamples;

      const commitAcc = commitAccounts();
      const { ms: undelMs, result: undelSig } = await timeIt(() =>
        erSession.methods.undelegate().accounts({ payer: owner, probe: pda, sessionToken: null, ...commitAcc }).rpc(),
      );
      logStep(P, "undelegate (asia ER)", true, { ms: undelMs, signature: undelSig });
      results.session.undelegateSig = undelSig;

      const finalAccount = await programs.session.account.sessionProbe.fetch(pda);
      results.session.finalPingCount = finalAccount.pingCount.toString();
      logStep(P, "final state read (base layer)", true, { note: `ping_count=${finalAccount.pingCount.toString()} (1 wallet ping + 3 session pings expected on top of prior runs)` });
    } catch (e) {
      logStep(P, "unhandled error", false, { note: e.message || String(e) });
      results.session = { ...(results.session || {}), error: e.message || String(e) };
    }
  }

  function buildMarkdown(walletAddr) {
    const lines = [];
    lines.push("# Mission Control - real devnet verification results");
    lines.push("");
    lines.push(`Generated ${new Date().toISOString()} by \`app/scripts/verify-e2e.js\`, run against real Solana devnet.`);
    lines.push("");
    lines.push(`Wallet: \`${walletAddr}\` (${explorerAddr(new PublicKey(walletAddr))})`);
    lines.push("");
    lines.push("Every number below came from an actual confirmed transaction or a real account fetch - click any explorer link to check it yourself on Solana's devnet explorer.");
    lines.push("");
    for (const p of ["Core", "VRF", "Actions", "Crank", "Oracle", "Session"]) {
      const steps = report.filter((r) => r.probe === p);
      if (steps.length === 0) continue;
      lines.push(`## ${p}`);
      lines.push("");
      for (const s of steps) {
        const status = s.ok ? "PASS" : "FAIL";
        const ms = s.ms !== undefined ? ` — ${s.ms}ms` : "";
        const link = s.signature ? ` — [tx](${explorerTx(s.signature)})` : "";
        const note = s.note ? ` — ${s.note}` : "";
        lines.push(`- **${status}** ${s.step}${ms}${link}${note}`);
      }
      lines.push("");
    }
    lines.push("## Raw data");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(results, null, 2));
    lines.push("```");
    return lines.join("\n");
  }
}

main().catch((e) => {
  console.error("Fatal error running verification script:", e);
  process.exit(1);
});
