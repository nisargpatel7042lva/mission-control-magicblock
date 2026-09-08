// Mission Control - MagicBlock router lookups.
//
// `getDelegationStatus` is the router's own account-to-ER routing lookup
// (see the magicblock dev skill's `debugging.md`: a JSON-RPC POST with
// exactly one account in `params`, documented request/response shape
// reproduced below - not guessed). Used to find which specific ER
// validator currently hosts a delegated account - most importantly,
// MagicBlock's own Pricing Oracle feed, which is ER-native by design (see
// github.com/magicblock-labs/real-time-pricing-oracle's own README: it
// describes itself as injecting price feeds "into ephemeral rollups") - so
// a probe can be delegated to that SAME validator rather than an arbitrary
// region, and both accounts end up visible to one runtime.
//
// Example response for a delegated account (from debugging.md):
//   {
//     "result": {
//       "isDelegated": true,
//       "fqdn": "https://devnet-as.magicblock.app/",
//       "delegationRecord": {
//         "authority": "<validator_identity>",
//         "owner": "<original_program_id>",
//         "delegationSlot": 388473478,
//         "lamports": 15144960
//       }
//     }
//   }

import { ROUTER_RPC } from "./regions";

export interface DelegationRecord {
  authority: string;
  owner: string;
  delegationSlot: number;
  lamports: number;
}

export interface DelegationStatus {
  isDelegated: boolean;
  fqdn?: string;
  delegationRecord?: DelegationRecord;
}

export async function getDelegationStatus(pubkeyBase58: string): Promise<DelegationStatus> {
  const res = await fetch(ROUTER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getDelegationStatus",
      params: [pubkeyBase58],
    }),
  });
  if (!res.ok) {
    throw new Error(`router getDelegationStatus HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`router getDelegationStatus RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result as DelegationStatus;
}
