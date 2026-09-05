// Mission Control - Program instances bound to a specific (possibly
// regional ER) RPC endpoint. Needed because once a probe account is
// delegated, base-layer RPC can no longer execute instructions against it -
// only the ER validator holding the delegation can, so "ping" while
// delegated must go to that validator's own endpoint, not the base layer
// one the rest of the app defaults to.

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Wallet } from "@coral-xyz/anchor/dist/cjs/provider";
import { Connection } from "@solana/web3.js";

const connectionCache = new Map<string, Connection>();

export function connectionForEndpoint(endpoint: string): Connection {
  let c = connectionCache.get(endpoint);
  if (!c) {
    c = new Connection(endpoint, "confirmed");
    connectionCache.set(endpoint, c);
  }
  return c;
}

// `idl` is intentionally untyped (see the matching note in use-programs.ts):
// casting a raw JSON IDL to the generic `Idl` interface erases its literal
// shape and breaks Anchor's per-instruction `.accounts()` typing for several
// of our instructions.
export function programForEndpoint(idl: any, endpoint: string, wallet: Wallet): Program<any> {
  const provider = new AnchorProvider(connectionForEndpoint(endpoint), wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program(idl, provider);
}
