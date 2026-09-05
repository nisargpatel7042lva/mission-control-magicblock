"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";

import { useMissionControlPrograms } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { oracleProbePda } from "@/lib/pdas";
import { ORACLE_FIXTURES } from "@/lib/oracle-fixtures";
import { useEventLog } from "@/lib/event-log";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "Pricing Oracle";

interface OracleAccount {
  lastPrice: { toString(): string };
  lastExponent: number;
  lastPublishTime: { toNumber(): number };
  observationCount: { toString(): string };
}

export function OracleProbePanel() {
  const wallet = useWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();
  const [fixtureIdx, setFixtureIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const fixture = ORACLE_FIXTURES[fixtureIdx];

  const probePda = useMemo(
    () => (wallet.publicKey ? oracleProbePda(wallet.publicKey, fixture.feedId)[0] : null),
    [wallet.publicKey, fixture],
  );

  const { data } = usePolledAccount<OracleAccount>(programs?.oracle, "priceProbe", probePda, 5000);

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
        ageSeconds !== null && (
          <Badge tone={ageSeconds > 60 ? "rose" : ageSeconds > 30 ? "amber" : "emerald"}>{ageSeconds}s old</Badge>
        )
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
          onChange={(e) => setFixtureIdx(Number(e.target.value))}
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
              if (!programs) throw new Error("not ready");
              return programs.oracle.methods
                .observePrice()
                .accounts({ probe: probePda, priceUpdate: fixture.priceUpdate } as any)
                .rpc();
            })
          }
        >
          Observe price
        </ActionButton>
      </ButtonRow>
      <p className="text-[11px] text-zinc-500">
        Fixtures are MagicBlock&apos;s own devnet test feeds (from their{" "}
        <code>oracle-priced-purchase</code> example) - they could rotate independently of this app.
      </p>
    </Panel>
  );
}
