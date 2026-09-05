"use client";

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";

import { useMissionControlPrograms, useAnchorCompatibleWallet } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { actionProbePda, milestonePda } from "@/lib/pdas";
import { PROBE_ACTIONS_ID } from "@/lib/programs";
import { delegateAccounts, commitAccounts } from "@/lib/delegation";
import { REGIONS, type RegionConfig } from "@/lib/regions";
import { programForEndpoint } from "@/lib/region-provider";
import { useEventLog } from "@/lib/event-log";
import probeActionsIdl from "@/lib/idl/probe_actions.json";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "Magic Actions";

interface ActionProbeAccount {
  count: { toString(): string };
}
interface MilestoneAccount {
  highValue: { toString(): string };
}

export function ActionsProbePanel() {
  const wallet = useWallet();
  const anchorWallet = useAnchorCompatibleWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();

  const [region] = useState<RegionConfig>(REGIONS[0]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const probePda = useMemo(
    () => (wallet.publicKey ? actionProbePda(wallet.publicKey)[0] : null),
    [wallet.publicKey],
  );
  const milePda = useMemo(
    () => (wallet.publicKey ? milestonePda(wallet.publicKey)[0] : null),
    [wallet.publicKey],
  );

  const activeProgram = useMemo(() => {
    if (!anchorWallet) return null;
    if (delegated) return programForEndpoint(probeActionsIdl as any, region.erRpc, anchorWallet);
    return (programs?.actions as Program<any>) ?? null;
  }, [anchorWallet, delegated, region, programs]);

  const { data: probeData } = usePolledAccount<ActionProbeAccount>(activeProgram, "actionProbe", probePda, 3000);
  const { data: milestoneData } = usePolledAccount<MilestoneAccount>(
    programs?.actions, // milestone always lives on base layer
    "milestone",
    milePda,
    3000,
  );

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

  const canAct = !!wallet.publicKey && !!programs && !!probePda && !!milePda;

  return (
    <Panel
      title="Magic Actions"
      subtitle="ER commit → base-layer side effect, no relayer"
      accent="amber"
      right={<Badge tone={delegated ? "emerald" : "zinc"}>{delegated ? `on ${region.label}` : "base layer"}</Badge>}
    >
      <StatGrid>
        <Stat label="probe count (ER)" value={probeData ? probeData.count.toString() : "—"} />
        <Stat label="milestone high (base)" value={milestoneData ? milestoneData.highValue.toString() : "—"} />
      </StatGrid>

      <ButtonRow>
        <ActionButton
          disabled={!canAct}
          busy={busy === "initialize"}
          onClick={() =>
            run("initialize", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              return programs.actions.methods
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
              const acc = delegateAccounts(probePda, PROBE_ACTIONS_ID);
              const sig = await programs.actions.methods
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
            run("ping", async () => {
              if (!activeProgram) throw new Error("not ready");
              return (activeProgram as any).methods.ping().accounts({ probe: probePda } as any).rpc();
            })
          }
        >
          Ping
        </ActionButton>

        <ActionButton
          tone="amber"
          disabled={!canAct || !delegated}
          busy={busy === "commit + schedule action"}
          onClick={() =>
            run("commit + schedule action", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              const acc = commitAccounts();
              return (activeProgram as any).methods
                .commitAndUpdateMilestone()
                .accounts({
                  payer: wallet.publicKey,
                  probe: probePda,
                  milestone: milePda,
                  programId: PROBE_ACTIONS_ID,
                  ...acc,
                } as any)
                .rpc();
            })
          }
        >
          Commit + schedule milestone update
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
        After scheduling, watch <span className="text-amber-400">milestone high (base)</span> above -
        it updates asynchronously once the network actually runs the post-commit action, which is
        the whole point: a successful schedule only means it was accepted, not that it ran yet.
      </p>
    </Panel>
  );
}
