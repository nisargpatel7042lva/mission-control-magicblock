"use client";

// Mission Control - Anchor Program instances, memoized per connected wallet.

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Wallet } from "@coral-xyz/anchor/dist/cjs/provider";
import { useMemo } from "react";

import probeCoreIdl from "./idl/probe_core.json";
import probeVrfIdl from "./idl/probe_vrf.json";
import probeActionsIdl from "./idl/probe_actions.json";
import probeCrankIdl from "./idl/probe_crank.json";
import probeOracleIdl from "./idl/probe_oracle.json";
import probeSessionIdl from "./idl/probe_session.json";
import { GPL_SESSION_IDL } from "./session-program";

/** The Anchor-shaped wallet object, reusable to build a Program bound to a different (e.g. regional ER) connection. */
export function useAnchorCompatibleWallet(): Wallet | null {
  const wallet = useWallet();
  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction as Wallet["signTransaction"],
      signAllTransactions: (wallet.signAllTransactions ??
        (async (txs) => txs)) as Wallet["signAllTransactions"],
    };
  }, [wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);
}

export function useMissionControlPrograms() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorCompatibleWallet();

  return useMemo(() => {
    if (!anchorWallet) return null;

    const provider = new AnchorProvider(connection, anchorWallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    // Pass each JSON IDL uncast: TypeScript infers `Program<typeof idlJson>`
    // straight from the JSON module's own literal type, which is what lets
    // Anchor's `.accounts()` typing discriminate per-instruction. Casting to
    // `Idl` (or `any`) genericizes the type param instead, and once that
    // happens, an account name that has a different "kind" (plain vs
    // `pda`-derived vs `optional`) across different instructions of the
    // *same* program - "probe" and "session_token" both do - can no longer
    // be disambiguated per-call, and Anchor's resolver collapses that key to
    // an unusable type everywhere, not just on the instructions that vary it.
    return {
      provider,
      core: new Program(probeCoreIdl, provider),
      vrf: new Program(probeVrfIdl, provider),
      actions: new Program(probeActionsIdl, provider),
      crank: new Program(probeCrankIdl, provider),
      oracle: new Program(probeOracleIdl, provider),
      session: new Program(probeSessionIdl, provider),
      gplSession: new Program(GPL_SESSION_IDL as any, provider),
    };
  }, [connection, anchorWallet]);
}

export type MissionControlPrograms = NonNullable<ReturnType<typeof useMissionControlPrograms>>;
