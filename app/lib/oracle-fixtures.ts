// Mission Control - devnet Pricing Oracle test fixtures.
//
// The two fixtures this file originally shipped with (from MagicBlock's
// `magicblock-engine-examples` repo, `oracle-priced-purchase/anchor/tests`)
// turned out to be dead on real devnet execution - `observe_price` reverted
// with Anchor's `AccountNotInitialized` (3012), meaning those accounts no
// longer exist on devnet. That's the exact rotation risk this file always
// warned about.
//
// Replacement below is MagicBlock's *live* Pricing Oracle service
// (program `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`, republishing Pyth
// Lazer feeds - see https://docs.magicblock.gg/pages/tools/oracle/introduction
// and https://github.com/magicblock-labs/real-time-pricing-oracle), derived
// and cross-checked as follows:
//
//   - Feed catalog: `pyth_lazer_list.json` in that repo lists SOL/USD as
//     `{ "pyth_lazer_id": 6, "symbol": "Crypto.SOL/USD", "exponent": -8 }`.
//   - Account address: the repo documents the PDA as
//     `findProgramAddressSync([Buffer.from("price_feed"),
//     Buffer.from("pyth-lazer"), Buffer.from(feedId)], PROGRAM_ID)`. Deriving
//     this locally with `feedId = Buffer.from(String(pyth_lazer_id))` (i.e.
//     the ASCII string "6") reproduces
//     `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` exactly - the same
//     address the repo's own README lists for SOL/USD. That match is a real
//     cryptographic confirmation, not a guess.
//   - `feed_id` (the 32-byte value probe-oracle's `initialize` needs, and
//     which the deserialized account's `price_message.feed_id` must equal):
//     the PDA seed above is MagicBlock's own internal catalog id, a
//     *different* value from the field this program checks. That field is
//     populated with the standard Pyth Price Feed id for the same symbol
//     (Pyth Lazer republishes into the same `PriceUpdateV2` shape regular
//     Pyth pull-oracle consumers use), confirmed against Pyth's own Hermes
//     feed registry (https://hermes.pyth.network/v2/price_feeds) for
//     `Crypto.SOL/USD`: `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.
//
// The account address is independently confirmed (PDA math matches a
// published address); the feed_id match is the one inference in this chain
// that isn't independently proven from here - if `observe_price` reverts
// with `UnexpectedFeed` rather than succeeding, that's the piece to
// revisit. Old fixtures kept below as fallback attempts in case this one
// is ever wrong or rotated in turn.

import { PublicKey } from "@solana/web3.js";

export interface OracleFixture {
  label: string;
  priceUpdate: PublicKey;
  feedId: Uint8Array;
}

function feedIdFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export const ORACLE_FIXTURES: OracleFixture[] = [
  {
    label: "SOL/USD (MagicBlock Pricing Oracle, live)",
    priceUpdate: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
    feedId: feedIdFromHex(
      "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    ),
  },
  {
    label: "SOL/USD (old example fixture @ $100, likely dead)",
    priceUpdate: new PublicKey("B8vx8v7SwZsmFYz3fkSJphr7uq34LoiVr18pimLG5FJM"),
    feedId: feedIdFromHex(
      "969cefe5a1c3dc424aeaf191893d642799b8545431b5e2560e1cc78ccfdd91d6".slice(0, 64),
    ),
  },
  {
    label: "SOL/USD (old example fixture @ $50, likely dead)",
    priceUpdate: new PublicKey("EpdAP2KHQAXPccREjM1WsLiyKVcchYj82pv9sWZhYUY1"),
    feedId: feedIdFromHex(
      "cd5b1dc2e5486ee8a1fa93a76ad56a1d15fef45c54fac50c7b489f1f3be0136a".slice(0, 64),
    ),
  },
];
