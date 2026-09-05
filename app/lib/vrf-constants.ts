// Mission Control - VRF oracle constants.
//
// Pulled directly from the vendored `ephemeral-vrf-sdk` v0.4.1 Rust crate
// (`src/consts.rs`) that `probe-vrf` actually compiles against - not
// guessed, so they stay correct even if MagicBlock's docs lag the crate.

import { PublicKey } from "@solana/web3.js";

export const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz",
);

/** Base-layer production oracle queue. */
export const DEFAULT_QUEUE = new PublicKey(
  "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh",
);
/** Delegated (ER-local) production oracle queue - use this once the probe is delegated. */
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc",
);
export const DEFAULT_TEST_QUEUE = new PublicKey(
  "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb",
);
export const DEFAULT_EPHEMERAL_TEST_QUEUE = new PublicKey(
  "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT",
);
