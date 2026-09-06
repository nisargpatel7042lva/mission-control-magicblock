"use client";

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { Program, Idl } from "@coral-xyz/anchor";

/**
 * Polls one Anchor account on an interval. `accountNamespace` is the
 * camelCased IDL account name (e.g. IDL account "PriceProbe" -> "priceProbe").
 */
export function usePolledAccount<T = unknown>(
  program: Program<Idl> | null | undefined,
  accountNamespace: string,
  pda: PublicKey | null | undefined,
  intervalMs = 4000,
) {
  const [data, setData] = useState<T | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const pdaKey = pda?.toBase58();

  useEffect(() => {
    if (!program || !pda) return;
    let alive = true;

    async function poll() {
      try {
        const namespace = (program!.account as any)[accountNamespace];
        const acc = await namespace.fetch(pda);
        if (alive) {
          setData(acc as T);
          setExists(true);
          setLastPolledAt(Date.now());
        }
      } catch {
        if (alive) {
          setExists(false);
          setLastPolledAt(Date.now());
        }
      }
    }

    // Stagger each panel's poll tick by a small random offset so six panels
    // mounting at once don't all hit the RPC in the same instant - spreads
    // the request burst out instead of amplifying it every interval.
    const jitter = Math.floor(Math.random() * 600);
    const initial = setTimeout(poll, jitter);
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearTimeout(initial);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, accountNamespace, pdaKey, intervalMs]);

  return { data, exists, lastPolledAt };
}
