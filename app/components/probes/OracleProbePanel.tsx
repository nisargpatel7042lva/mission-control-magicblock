"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";

import { useMissionControlPrograms, useAnchorCompatibleWallet } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { oracleProbePda } from "@/lib/pdas";
import { PROBE_ORACLE_ID } from "@/lib/programs";
import { ORACLE_FIXTURES } from "@/lib/oracle-fixtures";
import { DELEGATION_PROGRAM_ID, delegateAccounts } from "@/lib/delegation";
import { REGIONS } from "@/lib/regions";
import { programForEndpoint } from "@/lib/region-provider";
import { useEventLog } from "@/lib/event-log";
import probeOracleIdl from "@/lib/idl/probe_oracle.json";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "Pricing Oracle";
const ORACLE_ER = REGIONS[0]; // Asia - same shared ER every other probe in this app uses.

/**
 * MagicBlock's Pricing Oracle feed is delegated into an Ephemeral Rollup
 * (see programs/probe-oracle/src/lib.rs's module doc comment for the
 * source-verified writeup of exactly how), so a base-layer-only read fails
 * with an owner-mismatch error whenever that's the case - checked here
 * directly against the account's real on-chain owner, not via router
 * getDelegationStatus (that call reliably errors for this specific feed:
 * it's delegated in a documented "any validator" mode with no single ER to
 * name, real error confirmed on a real devnet run: `-32604 "account has
 * been delegated to unknown ER node: 11111111111111111111111111111111"`).
 * Since "any validator" means any ER can see it, this just delegates our
 * own probe the ordinary way to the same shared Asia ER every other probe
 * here already uses, and reads the feed there.
 */
async function observePriceRouted(
  programs: NonNullable<ReturnType<typeof useMissionControlPrograms>>,
  anchorWallet: NonNullable<ReturnType<typeof useAnchorCompatibleWallet>>,
  connection: ReturnType<typeof useConnection>["connection"],
  payer: PublicKey,
  probePda: PublicKey,
  priceUpdate: PublicKey,
): Promise<{ sig: string; erEndpoint: string | null }> {
  const feedInfo = await connection.getAccountInfo(priceUpdate);
  const feedIsDelegated = !!feedInfo && feedInfo.owner.equals(DELEGATION_PROGRAM_ID);

  if (!feedIsDelegated) {
    const sig = await programs.oracle.methods
      .observePrice()
      .accounts({ probe: probePda, priceUpdate } as any)
      .rpc();
    return { sig, erEndpoint: null };
  }

  const probeInfo = await connection.getAccountInfo(probePda);
  const probeIsDelegated = !!probeInfo && probeInfo.owner.equals(DELEGATION_PROGRAM_ID);

  if (!probeIsDelegated) {
    const acc = delegateAccounts(probePda, PROBE_ORACLE_ID);
    await (programs.oracle.methods as any)
      .delegate()
      .accounts({ payer, pda: probePda, ...acc } as any)
      .rpc();
  }

  const erOracle = programForEndpoint(probeOracleIdl as any, ORACLE_ER.erRpc, anchorWallet);
  const sig = await (erOracle as any).methods
    .observePrice()
    .accounts({ probe: probePda, priceUpdate } as any)
    .rpc();
  return { sig, erEndpoint: ORACLE_ER.erRpc };
}

interface OracleAccount {
  lastPrice: { toString(): string };
  lastExponent: number;
  lastPublishTime: { toNumber(): number };
  observationCount: { toString(): string };
}

export function OracleProbePanel() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const anchorWallet = useAnchorCompatibleWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();
  const [fixtureIdx, setFixtureIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // Which ER (if any) the probe was last actually read from - null means
  // base layer. Set from the real result of the last observe_price call,
  // never assumed ahead of time.
  const [erEndpoint, setErEndpoint] = useState<string | null>(null);
  const fixture = ORACLE_FIXTURES[fixtureIdx];

  const probePda = useMemo(
    () => (wallet.publicKey ? oracleProbePda(wallet.publicKey, fixture.feedId)[0] : null),
    [wallet.publicKey, fixture],
  );

  const activeProgram = useMemo(() => {
    if (!anchorWallet) return null;
    if (erEndpoint) return programForEndpoint(probeOracleIdl as any, erEndpoint, anchorWallet);
    return (programs?.oracle as Program<any>) ?? null;
  }, [anchorWallet, erEndpoint, programs]);

  const { data } = usePolledAccount<OracleAccount>(activeProgram, "priceProbe", probePda, 5000);

  // Freshness ("Xs old") needs a live clock, but reading `Date.now()`
  // directly in the render body is an impure render (breaks React 19 /
  // Next 16 compiler assumptions) - tick it from an effect instead so the
  // component stays a pure function of its state.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Tick from the interval callback only - an effect body should
    // subscribe to the external clock, not itself synchronously trigger the
    // first render's worth of state (that would just be an unnecessary
    // cascading render immediately after mount).
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(label);
      const id = log({ source: SOURCE, level: "pending", message: `${label}…` });
      const t0 = performance.now();
      try {
        const sig = await fn();
        update(id, {
          level: "success",
          message: `${label} confirmed`,
          durationMs: Math.round(performance.now() - t0),
          signature: sig,
        });
      } catch (e) {
        update(id, {
          level: "error",
          message: `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: Math.round(performance.now() - t0),
        });
      } finally {
        setBusy(null);
      }
    },
    [log, update],
  );

  const canAct = !!wallet.publicKey && !!programs && !!probePda;
  const priceDisplay = data
    ? (Number(data.lastPrice.toString()) * Math.pow(10, data.lastExponent)).toFixed(4)
    : "—";
  const ageSeconds =
    data && now !== null ? Math.max(0, Math.floor(now / 1000 - data.lastPublishTime.toNumber())) : null;

  return (
    <Panel
      title="Pricing Oracle"
      subtitle="verified Pyth/Lazer feed read - feed-id + freshness checked on-chain"
      accent="emerald"
      right={
        <div className="flex items-center gap-2">
          <Badge tone={erEndpoint ? "emerald" : "zinc"}>{erEndpoint ? `on ${ORACLE_ER.label}` : "base layer"}</Badge>
          {ageSeconds !== null && (
            <Badge tone={ageSeconds > 60 ? "rose" : ageSeconds > 30 ? "amber" : "emerald"}>{ageSeconds}s old</Badge>
          )}
        </div>
      }
    >
      <StatGrid>
        <Stat label="price" value={priceDisplay} />
        <Stat label="observations" value={data ? data.observationCount.toString() : "—"} />
      </StatGrid>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">feed</span>
        <select
          value={fixtureIdx}
          onChange={(e) => {
            // A different feed can be delegated to a different ER (or none)
            // than the one we were last reading from - don't carry a stale
            // ER binding across a feed switch, let the next observe_price
            // call re-discover it for real.
            setFixtureIdx(Number(e.target.value));
            setErEndpoint(null);
          }}
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200"
        >
          {ORACLE_FIXTURES.map((f, i) => (
            <option key={f.label} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <ButtonRow>
        <ActionButton
          disabled={!canAct}
          busy={busy === "initialize"}
          onClick={() =>
            run("initialize", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              return programs.oracle.methods
                .initialize(Array.from(fixture.feedId))
                .accounts({ user: wallet.publicKey, systemProgram: SystemProgram.programId } as any)
                .rpc();
            })
          }
        >
          Initialize
        </ActionButton>

        <ActionButton
          tone="emerald"
          disabled={!canAct}
          busy={busy === "observe price"}
          onClick={() =>
            run("observe price", async () => {
              if (!wallet.publicKey || !programs || !anchorWallet || !probePda) throw new Error("not ready");
              const { sig, erEndpoint: usedEndpoint } = await observePriceRouted(
                programs,
                anchorWallet,
                connection,
                wallet.publicKey,
                probePda,
                fixture.priceUpdate,
              );
              setErEndpoint(usedEndpoint);
              return sig;
            })
          }
        >
          Observe price
        </ActionButton>
      </ButtonRow>
      <p className="text-[11px] text-zinc-500">
        This feed is often delegated into an Ephemeral Rollup rather than living on base layer -{" "}
        <span className="text-amber-400">Observe price</span> checks its real owner and reads it on{" "}
        {ORACLE_ER.label} automatically when that&apos;s the case, delegating this probe there on first use.
      </p>
    </Panel>
  );
}
