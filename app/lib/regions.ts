// Mission Control - region / endpoint configuration.
//
// MagicBlock publishes regional Ephemeral Rollup validators on Devnet and
// Mainnet. Per the magicblock dev skill, endpoints are version-sensitive and
// should be verified against current sources rather than hardcoded
// permanently - this file is the single place that assumption lives, so it
// can be updated in one spot if MagicBlock changes an endpoint or identity.
//
// Sources:
// - Base layer / router: https://docs.magicblock.gg (Ephemeral Rollup > Concepts)
// - Regional ER RPCs: MagicBlock's own example test suites
//   (magicblock-engine-examples/counter/anchor/tests) reference
//   https://devnet-as.magicblock.app/ (Asia) as a concrete Devnet ER; other
//   regions follow the documented {region}.magicblock.app naming.
// - Status API: https://status.magicblock.app/api/services

export type Region = "asia" | "europe" | "usa" | "tee";

export interface RegionConfig {
  id: Region;
  label: string;
  /** Devnet Ephemeral Rollup RPC endpoint for this region. */
  erRpc: string;
  erWs: string;
}

export const BASE_LAYER_RPC = "https://rpc.magicblock.app/devnet";
export const ROUTER_RPC = "https://devnet-router.magicblock.app/";
export const STATUS_API = "https://status.magicblock.app/api/services";

// Fallback if the wallet has no Devnet SOL and MagicBlock's own RPC is
// unreachable - kept distinct from BASE_LAYER_RPC so the dashboard can show
// which one it's actually using.
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export const REGIONS: RegionConfig[] = [
  {
    id: "asia",
    label: "Asia",
    erRpc: "https://devnet-as.magicblock.app/",
    erWs: "wss://devnet-as.magicblock.app/",
  },
  {
    id: "europe",
    label: "Europe",
    erRpc: "https://devnet-eu.magicblock.app/",
    erWs: "wss://devnet-eu.magicblock.app/",
  },
  {
    id: "usa",
    label: "USA",
    erRpc: "https://devnet-us.magicblock.app/",
    erWs: "wss://devnet-us.magicblock.app/",
  },
  {
    id: "tee",
    label: "TEE (Private ER)",
    erRpc: "https://devnet-tee.magicblock.app/",
    erWs: "wss://devnet-tee.magicblock.app/",
  },
];

// Devnet delegation-program validator identities. `probe-core`'s `delegate`
// instruction accepts an optional validator override via remaining_accounts;
// omitting it lets the Delegation Program pick a default. These identities
// come from MagicBlock's own test fixtures and should be reconfirmed against
// the router (`getIdentity`) before relying on them for anything beyond this
// demo, per the dev skill's "never invent program IDs / addresses" rule.
export const LOCALNET_VALIDATOR_IDENTITY =
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
export const DEVNET_ASIA_VALIDATOR_IDENTITY =
  "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57";
