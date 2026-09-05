"use client";

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";

import { useMissionControlPrograms } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { vrfProbePda, vrfProgramIdentityPda } from "@/lib/pdas";
import { PROBE_VRF_ID } from "@/lib/programs";
import { DEFAULT_QUEUE, DEFAULT_EPHEMERAL_QUEUE, VRF_PROGRAM_ID } from "@/lib/vrf-constants";
import { useEventLog } from "@/lib/event-log";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "VRF";
const STATUS_LABEL = ["idle", "requested", "fulfilled"];

interface VrfAccount {
  status: number;
  lastResult: number;
  requestCount: { toString(): string };
  requestedAtSlot: { toString(): string };
  fulfilledAtSlot: { toString(): string };
}

export function VrfProbePanel() {
  const wallet = useWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [useEphemeralQueue, setUseEphemeralQueue] = useState(false);

  const probePda = useMemo(
    () => (wallet.publicKey ? vrfProbePda(wallet.publicKey)[0] : null),
    [wallet.publicKey],
  );
  const programIdentity = useMemo(() => vrfProgramIdentityPda(PROBE_VRF_ID)[0], []);

  const { data } = usePolledAccount<VrfAccount>(programs?.vrf, "vrfProbe", probePda, 2500);

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
  const status = data ? STATUS_LABEL[data.status] ?? "unknown" : "—";

  return (
    <Panel
      title="VRF"
      subtitle="two-phase request → oracle callback"
      accent="violet"
      right={<Badge tone={status === "fulfilled" ? "emerald" : status === "requested" ? "amber" : "zinc"}>{status}</Badge>}
    >
      <StatGrid>
        <Stat label="requests" value={data ? data.requestCount.toString() : "—"} />
        <Stat label="last result (1-100)" value={data ? data.lastResult : "—"} />
        <Stat label="requested slot" value={data ? data.requestedAtSlot.toString() : "—"} />
        <Stat label="fulfilled slot" value={data ? data.fulfilledAtSlot.toString() : "—"} />
      </StatGrid>

      <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-zinc-500">
        <input
          type="checkbox"
          checked={useEphemeralQueue}
          onChange={(e) => setUseEphemeralQueue(e.target.checked)}
          className="accent-violet-500"
        />
        use delegated (ephemeral) queue - only valid once this probe is delegated to an ER
      </label>

      <ButtonRow>
        <ActionButton
          disabled={!canAct}
          busy={busy === "initialize"}
          onClick={() =>
            run("initialize", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              return programs.vrf.methods
                .initialize()
                .accounts({ payer: wallet.publicKey, systemProgram: SystemProgram.programId } as any)
                .rpc();
            })
          }
        >
          Initialize
        </ActionButton>

        <ActionButton
          tone="violet"
          disabled={!canAct}
          busy={busy === "request randomness"}
          onClick={() =>
            run("request randomness", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              const clientSeed = Math.floor(Math.random() * 255);
              return programs.vrf.methods
                .requestRandomness(clientSeed)
                .accounts({
                  payer: wallet.publicKey,
                  probe: probePda,
                  oracleQueue: useEphemeralQueue ? DEFAULT_EPHEMERAL_QUEUE : DEFAULT_QUEUE,
                  programIdentity,
                  vrfProgram: VRF_PROGRAM_ID,
                  slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
                  systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            })
          }
        >
          Request randomness
        </ActionButton>
      </ButtonRow>
      <p className="text-[11px] text-zinc-500">
        The callback (`consume_randomness`) is invoked by the VRF oracle itself, not from here -
        watch the status flip <span className="text-violet-400">requested → fulfilled</span> above.
      </p>
    </Panel>
  );
}
