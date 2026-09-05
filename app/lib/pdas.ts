// Mission Control - PDA derivations for our own 6 probe programs, mirroring
// the `seeds = [...]` constraints in each program's Rust source exactly.
// Kept in one place so a seed typo breaks obviously (one wrong panel) rather
// than silently (a probe that "works" against the wrong address).

import { PublicKey } from "@solana/web3.js";
import {
  PROBE_ACTIONS_ID,
  PROBE_CORE_ID,
  PROBE_CRANK_ID,
  PROBE_ORACLE_ID,
  PROBE_SESSION_ID,
  PROBE_VRF_ID,
  SEED_ACTION_PROBE,
  SEED_CORE_PROBE,
  SEED_CRANK_PROBE,
  SEED_MILESTONE,
  SEED_ORACLE_PROBE,
  SEED_SESSION_PROBE,
  SEED_VRF_PROBE,
} from "./programs";

export function coreProbePda(owner: PublicKey, label: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_CORE_PROBE, owner.toBuffer(), Buffer.from(label)],
    PROBE_CORE_ID,
  );
}

export function vrfProbePda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_VRF_PROBE, owner.toBuffer()], PROBE_VRF_ID);
}

export function actionProbePda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_ACTION_PROBE, owner.toBuffer()], PROBE_ACTIONS_ID);
}

export function milestonePda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_MILESTONE, owner.toBuffer()], PROBE_ACTIONS_ID);
}

export function crankProbePda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_CRANK_PROBE, owner.toBuffer()], PROBE_CRANK_ID);
}

export function oracleProbePda(owner: PublicKey, feedId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ORACLE_PROBE, owner.toBuffer(), Buffer.from(feedId)],
    PROBE_ORACLE_ID,
  );
}

export function sessionProbePda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_SESSION_PROBE, authority.toBuffer()],
    PROBE_SESSION_ID,
  );
}

/** `#[vrf]`-injected scoped identity PDA, seeded `[b"identity"]` under the calling program itself. */
export function vrfProgramIdentityPda(callingProgram: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], callingProgram);
}
