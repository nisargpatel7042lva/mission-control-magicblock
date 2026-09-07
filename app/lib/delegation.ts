// Mission Control - shared "delegate" account bundle.
//
// Every delegate-capable probe (core, session) needs the same five
// plumbing accounts the `#[delegate]` macro injects. Built from the
// official `@magicblock-labs/ephemeral-rollups-sdk` JS helpers (not
// hand-derived) so the seed math always matches whatever the Rust SDK the
// programs actually compiled against expects.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  escrowPdaFromEscrowAuthority,
  createTopUpEscrowInstruction,
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

/**
 * Magic Actions' post-commit callback (`update_milestone` in probe-actions)
 * is authenticated by requiring an escrow PDA -
 * `ephemeral_balance_pda_from_payer(escrow_auth, 255)` on the Rust side -
 * to sign; only the delegation program can sign for that PDA, which is what
 * proves a call actually arrived through the real post-commit path rather
 * than a spoofed direct call. That account has to actually exist and hold a
 * little SOL for the delegation program to spend on the action's compute
 * budget - nothing creates or funds it automatically, so any commit that
 * schedules a post-commit action must top it up first or the action never
 * lands (the commit transaction itself still succeeds, which is what made
 * this easy to miss - "milestone high (base)" just silently never updates).
 */
export function actionEscrowPda(escrowAuthority: PublicKey, index = 255): PublicKey {
  return escrowPdaFromEscrowAuthority(escrowAuthority, index);
}

export function topUpEscrowInstruction(
  escrowAuthority: PublicKey,
  payer: PublicKey,
  lamports: number,
  index = 255,
): TransactionInstruction {
  return createTopUpEscrowInstruction(actionEscrowPda(escrowAuthority, index), escrowAuthority, payer, lamports, index);
}
