// Mission Control - shared "delegate" account bundle.
//
// Every delegate-capable probe (core, session) needs the same five
// plumbing accounts the `#[delegate]` macro injects. Built from the
// official `@magicblock-labs/ephemeral-rollups-sdk` JS helpers (not
// hand-derived) so the seed math always matches whatever the Rust SDK the
// programs actually compiled against expects.

import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

export { DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID };

export function delegateAccounts(probePda: PublicKey, ownerProgramId: PublicKey) {
  return {
    bufferPda: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(probePda, ownerProgramId),
    delegationRecordPda: delegationRecordPdaFromDelegatedAccount(probePda),
    delegationMetadataPda: delegationMetadataPdaFromDelegatedAccount(probePda),
    ownerProgram: ownerProgramId,
    delegationProgram: DELEGATION_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

export function commitAccounts() {
  return {
    magicProgram: MAGIC_PROGRAM_ID,
    magicContext: MAGIC_CONTEXT_ID,
  };
}
