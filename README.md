# Mission Control

A live ops console for **MagicBlock Ephemeral Rollups** on Solana devnet — six
independent on-chain probes, one per MagicBlock primitive, each driven and
timed live from a Next.js dashboard so the ER-vs-base-layer speed difference
is *measured on screen*, not just claimed.

Built solo for **Solana Blitz V8** (MagicBlock, Sep 4–11 2026).

**Live demo:** https://mission-control-magicblock.vercel.app

## What it does

Every submission to this track has to integrate MagicBlock's Ephemeral
Rollup. Mission Control goes further and wires up every primitive MagicBlock
ships, each as its own Anchor program so the pattern is provably real rather
than simulated:

| Probe | Primitive | What you see |
| --- | --- | --- |
| `probe-core` | Ephemeral Rollup core lifecycle | delegate → ping (ER speed) → commit → undelegate, across multiple regions, with real round-trip timings |
| `probe-vrf` | Verifiable Random Function | two-phase request → oracle callback, timed from request to fulfillment |
| `probe-actions` | Magic Actions | an ER commit that triggers a real base-layer side effect with no relayer in between |
| `probe-crank` | Cranks | scheduled, autonomous on-chain execution — iterations are polled and observed, never assumed |
| `probe-oracle` | Pricing Oracle | verified Pyth/Lazer feed reads with on-chain freshness and feed-id checks |
| `probe-session` | Session Keys | one wallet popup, then N pings signed by a session key with no further prompts |

Every account write, delegation, and settlement is logged to a live Mission
Log so you can watch each phase (pending → observed → settled) resolve in
real time instead of trusting a single transaction's success.

## Why six programs instead of one ER demo

Judging rewards creativity, technical depth, and how compellingly a project
shows what's possible on Solana. A single ER counter proves delegation
works; it doesn't prove VRF, Magic Actions, cranks, oracle reads, or session
keys work, and it gives judges nothing to actually operate. Mission Control
is built so every primitive is independently exercised, independently
timed, and independently demoable — see [ARCHITECTURE.md](./ARCHITECTURE.md)
for the full decision log, account/delegation model, routing table, and
security notes (including a real auth gap fixed relative to MagicBlock's own
reference `magic-actions` example).

## Repo layout

```
programs/            6 Anchor programs, one per probe (Rust)
scripts/              devnet wallet/keypair helpers, program-ids.json
app/                  Next.js 16 + React 19 dashboard
  app/page.tsx         assembles all six probe panels
  components/probes/   one panel per primitive
  lib/                  Anchor program/provider wiring, PDAs, polling hooks,
                        per-region ER connection handling, session-key flow
  lib/idl/              generated Anchor IDLs the frontend reads directly
ARCHITECTURE.md       full design rationale, decision log, validation plan
DEPLOY-README.md      how the devnet program deployment is packaged/run
deploy-devnet.sh       one-shot devnet deploy script (wallet, airdrop, all 6 programs)
```

## Running the dashboard locally

```bash
cd app
npm install
npm run dev
```

Requires a Solana wallet adapter-compatible wallet (Phantom, Backpack, …) set
to devnet.

## Deploying the programs

The six programs' devnet addresses are already fixed in `Anchor.toml` and
each program's `declare_id!`. `deploy-devnet.sh` (see
[DEPLOY-README.md](./DEPLOY-README.md)) builds a wallet, airdrops devnet SOL,
and deploys all six — re-run it any time to redeploy against the same
addresses.

## Tech

Anchor / Rust programs, MagicBlock `ephemeral-rollups-sdk` (delegation,
commit, VRF, Magic Actions, cranks), Solana web3.js, Next.js 16, React 19,
Tailwind, `@solana/wallet-adapter-react`.
