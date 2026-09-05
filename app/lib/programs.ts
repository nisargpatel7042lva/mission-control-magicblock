// Mission Control - central program/account constants.
//
// Program IDs mirror declare_id!() in each Rust program and Anchor.toml -
// keep these three in sync if a program is ever redeployed with a fresh
// keypair.

import { PublicKey } from "@solana/web3.js";

export const PROBE_CORE_ID = new PublicKey(
  "96ru2VBdLyqvtvVTwgAKs9e4k8DVqpero5dHvXTVkfEA",
);
export const PROBE_VRF_ID = new PublicKey(
  "EzQLQDFAapDwyHnPsv9PUnt4mEbrLPfgnpBJmeu766fT",
);
export const PROBE_ACTIONS_ID = new PublicKey(
  "63pMnDypD8SVayKfXz1HbHjbQW1caX82UPRgsK4wSegh",
);
export const PROBE_CRANK_ID = new PublicKey(
  "gzNGTCNmCBfxGJL5t5XExoeHsB9ooc4LUubZ41Po86K",
);
export const PROBE_ORACLE_ID = new PublicKey(
  "ELzCkEvf5EV6KVAQgvbuGyLZ9TJrfzvdCejKs6n85EPW",
);
export const PROBE_SESSION_ID = new PublicKey(
  "UxGyQjXVBWXRwocPs1sjhV2BLWRmjwPc93yGVEn4XHd",
);

// Seed prefixes - must match `pub const *_SEED: &[u8]` in each program.
export const SEED_CORE_PROBE = Buffer.from("probe");
export const SEED_VRF_PROBE = Buffer.from("vrf_probe");
export const SEED_ACTION_PROBE = Buffer.from("action_probe");
export const SEED_MILESTONE = Buffer.from("milestone");
export const SEED_CRANK_PROBE = Buffer.from("crank_probe");
export const SEED_ORACLE_PROBE = Buffer.from("oracle_probe");
export const SEED_SESSION_PROBE = Buffer.from("session_probe");

/** probe-core's `initialize` takes a fixed [u8; 16] label - pad/truncate any string to fit. */
export function toLabel16(label: string): Uint8Array {
  const out = new Uint8Array(16);
  const bytes = new TextEncoder().encode(label).slice(0, 16);
  out.set(bytes);
  return out;
}
