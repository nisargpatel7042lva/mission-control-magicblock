"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";

import { useMissionControlPrograms, useAnchorCompatibleWallet } from "@/lib/use-programs";
import { usePolledAccount } from "@/lib/use-poll-account";
import { sessionProbePda } from "@/lib/pdas";
import { PROBE_SESSION_ID } from "@/lib/programs";
import { delegateAccounts, commitAccounts } from "@/lib/delegation";
import { sessionTokenV2Pda } from "@/lib/session-program";
import { REGIONS, type RegionConfig } from "@/lib/regions";
import { programForEndpoint } from "@/lib/region-provider";
import { useEventLog } from "@/lib/event-log";
import probeSessionIdl from "@/lib/idl/probe_session.json";
import { ActionButton, Badge, ButtonRow, Panel, Stat, StatGrid } from "../ui";

const SOURCE = "Session Keys";

interface SessionAccount {
  pingCount: { toString(): string };
}

export function SessionProbePanel() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const anchorWallet = useAnchorCompatibleWallet();
  const programs = useMissionControlPrograms();
  const { log, update } = useEventLog();

  const [region] = useState<RegionConfig>(REGIONS[0]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sessionPings, setSessionPings] = useState(0);
  const sessionKeypairRef = useRef<Keypair | null>(null);
  const [hasSession, setHasSession] = useState(false);

  const probePda = useMemo(
    () => (wallet.publicKey ? sessionProbePda(wallet.publicKey)[0] : null),
    [wallet.publicKey],
  );

  const activeProgram = useMemo(() => {
    if (!anchorWallet) return null;
    if (delegated) return programForEndpoint(probeSessionIdl as any, region.erRpc, anchorWallet);
    return (programs?.session as Program<any>) ?? null;
  }, [anchorWallet, delegated, region, programs]);

  const { data } = usePolledAccount<SessionAccount>(activeProgram, "sessionProbe", probePda, 2500);

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
      title="Session Keys"
      subtitle="wallet-or-session dual auth - N pings, 1 popup"
      accent="rose"
      right={<Badge tone={hasSession ? "emerald" : "zinc"}>{hasSession ? "session active" : "wallet only"}</Badge>}
    >
      <StatGrid>
        <Stat label="ping count" value={data ? data.pingCount.toString() : "—"} />
        <Stat label="pings via session" value={sessionPings} />
      </StatGrid>

      <ButtonRow>
        <ActionButton
          disabled={!canAct}
          busy={busy === "initialize"}
          onClick={() =>
            run("initialize", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              return programs.session.methods
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
              const acc = delegateAccounts(probePda, PROBE_SESSION_ID);
              const sig = await programs.session.methods
                .delegate()
                .accounts({ payer: wallet.publicKey, pda: probePda, sessionToken: null, ...acc } as any)
                .rpc();
              setDelegated(true);
              return sig;
            })
          }
        >
          Delegate → {region.label}
        </ActionButton>

        <ActionButton
          tone="sky"
          disabled={!canAct}
          busy={busy === "ping via wallet"}
          onClick={() =>
            run("ping via wallet", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              return (activeProgram as any).methods
                .ping()
                .accounts({ payer: wallet.publicKey, probe: probePda, sessionToken: null } as any)
                .rpc();
            })
          }
        >
          Ping with wallet (popup)
        </ActionButton>

        <ActionButton
          tone="emerald"
          disabled={!canAct || hasSession}
          busy={busy === "create session"}
          onClick={() =>
            run("create session", async () => {
              if (!wallet.publicKey || !programs) throw new Error("not ready");
              const kp = Keypair.generate();
              const [tokenPda] = sessionTokenV2Pda(PROBE_SESSION_ID, kp.publicKey, wallet.publicKey);
              const sig = await programs.gplSession.methods
                .createSessionV2(true, null, new BN(5_000_000))
                .accounts({
                  sessionToken: tokenPda,
                  sessionSigner: kp.publicKey,
                  feePayer: wallet.publicKey,
                  authority: wallet.publicKey,
                  targetProgram: PROBE_SESSION_ID,
                  systemProgram: SystemProgram.programId,
                } as any)
                .signers([kp])
                .rpc();
              sessionKeypairRef.current = kp;
              setHasSession(true);
              setSessionPings(0);
              return sig;
            })
          }
        >
          Create session (1 popup, tops up 0.005 SOL)
        </ActionButton>

        <ActionButton
          tone="rose"
          disabled={!canAct || !hasSession}
          busy={busy === "ping via session"}
          onClick={() =>
            run("ping via session", async () => {
              if (!wallet.publicKey || !activeProgram) throw new Error("not ready");
              const kp = sessionKeypairRef.current;
              if (!kp) throw new Error("no active session");
              const [tokenPda] = sessionTokenV2Pda(PROBE_SESSION_ID, kp.publicKey, wallet.publicKey);
              const ix = await (activeProgram as any).methods
                .ping()
                .accounts({ payer: kp.publicKey, probe: probePda, sessionToken: tokenPda } as any)
                .instruction();
              const tx = new Transaction().add(ix);
              tx.feePayer = kp.publicKey;
              const { blockhash } = await connection.getLatestBlockhash();
              tx.recentBlockhash = blockhash;
              tx.sign(kp);
              const sig = await connection.sendRawTransaction(tx.serialize());
              await connection.confirmTransaction(sig, "confirmed");
              setSessionPings((n) => n + 1);
              return sig;
            })
          }
        >
          Ping via session (no popup)
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
                .accounts({ payer: wallet.publicKey, probe: probePda, sessionToken: null, ...acc } as any)
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
        &ldquo;Ping via session&rdquo; never opens your wallet - the ephemeral session key signs
        directly, and the program still checks it against an on-chain, expiring session token every
        single call.
      </p>
    </Panel>
  );
}
