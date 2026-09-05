"use client";

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";

import { useMissionControlPrograms, useAnchorCompatibleWallet } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { coreProbePda } from "@/lib/pdas";
import { toLabel16, PROBE_CORE_ID } from "@/lib/programs";
import { delegateAccounts, commitAccounts } from "@/lib/delegation";
import { REGIONS, type RegionConfig } from "@/lib/regions";
import { programForEndpoint } from "@/lib/region-provider";
import { useEventLog } from "@/lib/event-log";
import probeCoreIdl from "@/lib/idl/probe_core.json";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const LABEL = toLabel16("dashboard");
const SOURCE = "ER Core";

interface ProbeAccount {
  owner: unknown;
  pingCount: { toString(): string };
  lastValue: { toString(): string };
  lastUpdatedSlot: { toString(): string };
}

export function CoreProbePanel() {
  const wallet = useWallet();
  const anchorWallet = useAnchorCompatibleWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();

  const [region, setRegion] = useState<RegionConfig>(REGIONS[0]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const probePda = useMemo(
    () => (wallet.publicKey ? coreProbePda(wallet.publicKey, LABEL)[0] : null),
    [wallet.publicKey],
  );

  const activeProgram = useMemo<Program<any> | null>(() => {
    if (!anchorWallet) return null;
    if (delegated) return programForEndpoint(probeCoreIdl as any, region.erRpc, anchorWallet);
    return ((programs as any)?.core as Program<any>) ?? null;
  }, [anchorWallet, delegated, region, programs]);

  const { data, exists } = usePolledAccount<ProbeAccount>(
    activeProgram,
    "probe",
    probePda,
    3000,
  );

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(label);
      const id = log({ source: SOURCE, level: "pending", message: `${label}…` });
      const t0 = performance.now();
      try {
        const sig = await fn();
        const ms = Math.round(performance.now() - t0);
        update(id, { level: "success", message: `${label} confirmed`, durationMs: ms, signature: sig });
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        update(id, {
          level: "error",
          message: `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: ms,
        });
      } finally {
        setBusy(null);
      }
    },
    [log, update],
  );

  const canAct = !!wallet.publicKey && !!programs && !!probePda;

  return (
    <Panel
      title="ER Core"
      subtitle="delegate → ping → commit → undelegate lifecycle"
      accent="cyan"
      right={<Badge tone={delegated ? "emerald" : "zinc"}>{delegated ? `on ${region.label}` : "base layer"}</Badge>}
    >
      <StatGrid>
        <Stat label="probe" value={exists === false ? "not initialized" : probePda?.toBase58().slice(0, 8) + "…"} />
        <Stat label="ping count" value={data ? data.pingCount.toString() : "—"} />
        <Stat label="last value" value={data ? data.lastValue.toString() : "—"} />
        <Stat label="last slot" value={data ? data.lastUpdatedSlot.toString() : "—"} />
      </StatGrid>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">region</span>
        <select
          value={region.id}
          onChange={(e) => setRegion(REGIONS.find((r) => r.id === e.target.value) ?? REGIONS[0])}
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200"
        >
          {REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
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
              if (!wallet.publicKey || !programs) throw new Error("wallet not connected");
              return programs.core.methods
                .initialize(Array.from(LABEL))
                .accounts({ user: wallet.publicKey, systemProgram: SystemProgram.programId } as any)
                .rpc();
            })
          }
        >
          Initialize
        </ActionButton>

        <ActionButton
          tone="violet"
          disabled={!canAct || delegated}
          busy={busy === "delegate"}
          onClick={() =>
            run("delegate", async () => {
              if (!wallet.publicKey || !programs || !probePda) throw new Error("not ready");
              const acc = delegateAccounts(probePda, PROBE_CORE_ID);
              const sig = await programs.core.methods
                .delegate()
                .accounts({ payer: wallet.publicKey, pda: probePda, ...acc } as any)
                .rpc();
              setDelegated(true);
              return sig;
            })
          }
        >
          Delegate → {region.label}
        </ActionButton>

        <ActionButton
          tone="emerald"
          disabled={!canAct}
          busy={busy === "ping"}
          onClick={() =>
            run(delegated ? `ping (${region.label} ER)` : "ping (base layer)", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              return (activeProgram as any).methods
                .ping()
                .accounts({ probe: probePda } as any)
                .rpc();
            })
          }
        >
          Ping
        </ActionButton>

        <ActionButton
          tone="sky"
          disabled={!canAct || !delegated}
          busy={busy === "commit"}
          onClick={() =>
            run("commit", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              const acc = commitAccounts();
              return (activeProgram as any).methods
                .commit()
                .accounts({ payer: wallet.publicKey, probe: probePda, ...acc } as any)
                .rpc();
            })
          }
        >
          Commit
        </ActionButton>

        <ActionButton
          tone="amber"
          disabled={!canAct || !delegated}
          busy={busy === "undelegate"}
          onClick={() =>
            run("undelegate", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              const acc = commitAccounts();
              const sig = await (activeProgram as any).methods
                .undelegate()
                .accounts({ payer: wallet.publicKey, probe: probePda, ...acc } as any)
                .rpc();
              setDelegated(false);
              return sig;
            })
          }
        >
          Undelegate
        </ActionButton>
      </ButtonRow>
    </Panel>
  );
}
