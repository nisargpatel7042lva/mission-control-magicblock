"use client";

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";

import { useMissionControlPrograms, useAnchorCompatibleWallet } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { crankProbePda } from "@/lib/pdas";
import { PROBE_CRANK_ID } from "@/lib/programs";
import { delegateAccounts, commitAccounts, MAGIC_PROGRAM_ID } from "@/lib/delegation";
import { REGIONS, type RegionConfig } from "@/lib/regions";
import { programForEndpoint } from "@/lib/region-provider";
import { useEventLog } from "@/lib/event-log";
import probeCrankIdl from "@/lib/idl/probe_crank.json";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "Crank";

interface CrankAccount {
  count: { toString(): string };
  taskId: { toString(): string };
  lastScheduledSlot: { toString(): string };
}

export function CrankProbePanel() {
  const wallet = useWallet();
  const anchorWallet = useAnchorCompatibleWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();

  const [region] = useState<RegionConfig>(REGIONS[0]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const probePda = useMemo(
    () => (wallet.publicKey ? crankProbePda(wallet.publicKey)[0] : null),
    [wallet.publicKey],
  );

  const activeProgram = useMemo(() => {
    if (!anchorWallet) return null;
    if (delegated) return programForEndpoint(probeCrankIdl as any, region.erRpc, anchorWallet);
    return (programs?.crank as Program<any>) ?? null;
  }, [anchorWallet, delegated, region, programs]);

  const { data } = usePolledAccount<CrankAccount>(activeProgram, "crankProbe", probePda, 2500);

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

  return (
    <Panel
      title="Crank"
      subtitle="scheduled vs observed - a schedule tx only means it was accepted"
      accent="sky"
      right={<Badge tone={delegated ? "emerald" : "zinc"}>{delegated ? `on ${region.label}` : "base layer"}</Badge>}
    >
      <StatGrid>
        <Stat label="applied count" value={data ? data.count.toString() : "—"} />
        <Stat label="task id" value={data ? data.taskId.toString() : "—"} />
        <Stat label="last scheduled slot" value={data ? data.lastScheduledSlot.toString() : "—"} />
      </StatGrid>

      <ButtonRow>
        <ActionButton
          disabled={!canAct}
          busy={busy === "initialize"}
          onClick={() =>
            run("initialize", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              return programs.crank.methods
                .initialize()
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
              const acc = delegateAccounts(probePda, PROBE_CRANK_ID);
              const sig = await programs.crank.methods
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
          busy={busy === "ping (manual)"}
          onClick={() =>
            run("ping (manual)", async () => {
              if (!activeProgram) throw new Error("not ready");
              return (activeProgram as any).methods.ping().accounts({ probe: probePda } as any).rpc();
            })
          }
        >
          Ping manually
        </ActionButton>

        <ActionButton
          tone="amber"
          disabled={!canAct || !delegated}
          busy={busy === "schedule crank"}
          onClick={() =>
            run("schedule crank", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              const taskId = new BN(Date.now());
              return (activeProgram as any).methods
                .schedulePing({
                  taskId,
                  executionIntervalMillis: new BN(1000),
                  iterations: new BN(5),
                })
                .accounts({
                  magicProgram: MAGIC_PROGRAM_ID,
                  payer: wallet.publicKey,
                  probe: probePda,
                  program: PROBE_CRANK_ID,
                } as any)
                .rpc();
            })
          }
        >
          Schedule crank (5× / 1s)
        </ActionButton>

        <ActionButton
          tone="sky"
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
      <p className="text-[11px] text-zinc-500">
        Scheduling only confirms the ER scheduler accepted the request - watch{" "}
        <span className="text-sky-400">applied count</span> climb on its own over the next few
        seconds to see it actually run.
      </p>
    </Panel>
  );
}
