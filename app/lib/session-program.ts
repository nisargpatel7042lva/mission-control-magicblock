// Mission Control - minimal client for MagicBlock's shared `gpl_session`
// program (crate `session-keys` v3.1.1, `declare_id!("KeyspM2ss...")`).
//
// This program is MagicBlock infrastructure we don't deploy ourselves - it
// already lives on devnet. There's no published JS package for it, so this
// is a hand-written IDL fragment covering only what the dashboard calls
// (`create_session_v2`), built directly from the crate's own
// `CreateSessionTokenV2` accounts struct and `SessionTokenV2` layout
// (session-keys-3.1.1/src/lib.rs) rather than guessed.

import { PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";

export const GPL_SESSION_PROGRAM_ID = new PublicKey(
  "KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5",
);

export const SESSION_TOKEN_V2_SEED = Buffer.from("session_token_v2");

export function sessionTokenV2Pda(
  targetProgram: PublicKey,
  sessionSigner: PublicKey,
  authority: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_TOKEN_V2_SEED, targetProgram.toBuffer(), sessionSigner.toBuffer(), authority.toBuffer()],
    GPL_SESSION_PROGRAM_ID,
  );
}

// Anchor discriminators are the first 8 bytes of sha256("global:<name>") /
// sha256("account:<Name>") - Anchor's standard sighash scheme. Computed
// directly (not guessed) with:
//   python3 -c "import hashlib; print(list(hashlib.sha256(b'global:create_session_v2').digest()[:8]))"
export const GPL_SESSION_IDL: Idl = {
  address: GPL_SESSION_PROGRAM_ID.toBase58(),
  metadata: { name: "gpl_session", version: "3.1.1", spec: "0.1.0" },
  instructions: [
    {
      name: "create_session_v2",
      discriminator: [223, 233, 108, 7, 65, 194, 235, 38],
      accounts: [
        { name: "session_token", writable: true },
        { name: "session_signer", writable: true, signer: true },
        { name: "fee_payer", writable: true, signer: true },
        { name: "authority", signer: true },
        { name: "target_program" },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "top_up", type: { option: "bool" } },
        { name: "valid_until", type: { option: "i64" } },
        { name: "lamports", type: { option: "u64" } },
      ],
    },
    {
      name: "revoke_session_v2",
      discriminator: [211, 59, 125, 188, 43, 155, 8, 102],
      accounts: [
        { name: "session_token", writable: true },
        { name: "fee_payer", writable: true },
        { name: "authority" },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: "SessionTokenV2", discriminator: [178, 3, 85, 254, 13, 116, 128, 41] },
  ],
  types: [
    {
      name: "SessionTokenV2",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "target_program", type: "pubkey" },
          { name: "session_signer", type: "pubkey" },
          { name: "fee_payer", type: "pubkey" },
          { name: "valid_until", type: "i64" },
        ],
      },
    },
  ],
} as unknown as Idl;
