// Mission Control - devnet Pricing Oracle test fixtures.
//
// Real devnet accounts pulled from MagicBlock's own
// `magicblock-labs/magicblock-engine-examples` repo
// (`oracle-priced-purchase/anchor/tests/oracle-priced-purchase.ts`) - not
// invented. That test suite's Anchor.toml maps `[programs.devnet]`, so these
// are meant to be live on devnet; MagicBlock could still rotate them, so
// this is exactly where to look first if `observe_price` ever reverts with
// "stale or invalid".

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
    label: "SOL/USD (fixture @ $100)",
    priceUpdate: new PublicKey("B8vx8v7SwZsmFYz3fkSJphr7uq34LoiVr18pimLG5FJM"),
    feedId: feedIdFromHex(
      "969cefe5a1c3dc424aeaf191893d642799b8545431b5e2560e1cc78ccfdd91d6".slice(0, 64),
    ),
  },
  {
    label: "SOL/USD (fixture @ $50)",
    priceUpdate: new PublicKey("EpdAP2KHQAXPccREjM1WsLiyKVcchYj82pv9sWZhYUY1"),
    feedId: feedIdFromHex(
      "cd5b1dc2e5486ee8a1fa93a76ad56a1d15fef45c54fac50c7b489f1f3be0136a".slice(0, 64),
    ),
  },
];
