# Mission Control — MagicBlock architecture

Built for **Solana Blitz V8** (MagicBlock, Sep 4–11 2026). Structured per the
`magicblock` dev skill's architecture-planning template so the reasoning
behind every account, route, and settlement choice is explicit and
reviewable — not just the code.

## Decision

Use six independent probe programs — one per MagicBlock primitive (public
ER delegation lifecycle, VRF, Magic Actions, Cranks, Pricing Oracle, Session
Keys) — each delegated to a real Devnet Ephemeral Rollup validator, driven
live from a Next.js dashboard that times every phase of every operation and
renders it as a real-time console: regional latency map, delegation
lifecycle visualizer, VRF/action/crank round-trip timers, an oracle
freshness gauge, and a burst "stress test" mode. Keep every durable outcome
(milestones, oracle observations, session grants) on base layer; the ER is
always the low-latency execution venue, never the only copy of anything that
must survive.

## Goals and non-goals

- Goals: exercise every primitive MagicBlock ships (not just "an ER app"),
  make the ER-vs-base-layer speed difference *visible and measured* rather
  than asserted, produce a tool other Blitz builders / the MagicBlock team
  would actually want to keep using after judging.
- Non-goals: production security hardening beyond what's needed to make the
  probes honest (see Security below); mainnet deployment; a polished game
  loop or narrative — Mission Control's "product" is the console itself.

## Assumptions and open questions

- ASSUMPTION: Devnet is the target network for the live demo (per the dev
  skill, Devnet is the environment that proves router discovery, live
  delegation propagation, and hosted oracle/VRF services — exactly what this
  project needs to prove). — affects: RPC/router endpoints, faucet funding.
- ASSUMPTION: regional validator identities (Asia/EU/US/TEE) are read from
  MagicBlock's published Devnet validator list at build time, not
  hardcoded permanently, since the dev skill warns these are
  version-sensitive. — affects: `app/lib/regions.ts`.
- OPEN: whether the TEE-backed Private Ephemeral Rollup probe (stretch goal)
  ships depends on remaining time after the six core probes are solid and
  deployed — owner: build track, needed by: mid-week checkpoint.

## Product selection

| Capability | Selection | Rationale | Rejected alternative |
| --- | --- | --- | --- |
| Prove ER speed vs base layer | `probe-core` (public ER + delegate/commit/undelegate) | Directly measurable 10ms-vs-400ms claim per the dev skill's architecture diagram | Simulating latency client-side (not a real proof) |
| Provably fair randomness | `probe-vrf` | Required primitive for the "VRF in games/lotteries" use case; two-phase request/callback is the interesting thing to *time and visualize*, not just call | Client-side PRNG (not verifiable, not a MagicBlock feature) |
| Base-layer effect tied to a commit | `probe-actions` | Directly demonstrates the Magic Actions round trip and its authentication pitfall (see Security) | Polling a separate off-chain relayer (defeats the point of Magic Actions) |
| Recurring scheduled execution | `probe-crank` | Only primitive that shows autonomous, no-user-transaction execution | A client-side `setInterval` calling the program (not actually a MagicBlock crank) |
| Low-latency external market data | `probe-oracle` | Required to demonstrate real price-feed consumption with freshness verification | Faking a price locally (not a real oracle integration) |
| Frictionless repeated UX | `probe-session` | The clearest, most demoable "why does this matter to users" story — N pings, 1 wallet popup | Skipping session keys entirely (loses an entire primitive the eligibility criteria rewards covering) |
| Confidential state | Private Ephemeral Rollup probe (stretch) | Newest, least-explored MagicBlock primitive — differentiates from the inevitable wave of public-ER-only submissions | Full custom PER product (too much scope for remaining time; a focused probe is enough to prove it) |

## Account and delegation model

| Account | Owner / derivation | Authority | Created on | Persistence | ER role | Delegation group | Commit / close policy | Privacy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Probe` (`probe-core`) | `probe_core`; PDA `[probe, owner, label]` | owner wallet | base | base-settled | write | per-region probe | commit on demand, undelegate at end of stress-test run | public |
| `VrfProbe` | `probe_vrf`; PDA `[vrf_probe, owner]` | owner wallet | base | base-settled | write | vrf-probe | undelegate at end of demo | public |
| `ActionProbe` | `probe_actions`; PDA `[action_probe, owner]` | owner wallet | base | base-settled | write | actions-probe | commit+action per demo click | public |
| `Milestone` | `probe_actions`; PDA `[milestone, owner]` | owner wallet | base | base-settled (never delegated) | none (base-layer only; updated only via the `#[action]` post-commit path or the direct owner-signed path) | n/a | n/a | public |
| `CrankProbe` | `probe_crank`; PDA `[crank_probe, owner]` | owner wallet | base | base-settled | write | crank-probe | undelegate to inspect final count | public |
| `PriceProbe` | `probe_oracle`; PDA `[oracle_probe, owner, feed_id]` | owner wallet | base | base-settled | none (base-layer reads only in this snapshot) | n/a | n/a | public |
| `SessionProbe` | `probe_session`; PDA `[session_probe, owner]` | owner wallet, or a valid session token scoped to that owner | base | base-settled | write | session-probe | undelegate at end of demo | public |
| `SessionTokenV2` | `session-keys` program; PDA scoped by target program + session signer + wallet authority | wallet authority creates/revokes | base | base-settled | read (checked, not itself delegated) | n/a | wallet-controlled expiry/revocation | public (grants only; no funds custody) |
| Oracle `PriceUpdateV2` | MagicBlock Pricing Oracle republisher | oracle authority | base | base-settled, externally updated | n/a (read in `probe-oracle` on base layer) | n/a | n/a | public |
| VRF oracle queue | `ephemeral-rollups-sdk::vrf::consts` (`DEFAULT_EPHEMERAL_QUEUE` while delegated) | MagicBlock VRF oracle | base | base-settled, externally updated | write (delegated queue only) | n/a | n/a | public |

## Routing and settlement

| Flow | Actor / signers | Writable accounts | Destination | Preconditions | Settlement / confirmation | Failure path |
| --- | --- | --- | --- | --- | --- | --- |
| Initialize any probe | wallet | `<Probe>` | Base RPC | funded wallet | tx confirmed | retry with fresh blockhash |
| Delegate probe | wallet | `<Probe>` | Base RPC | probe initialized | account owner becomes Delegation Program; router `getDelegationStatus` resolves an `fqdn` | retry; if router never resolves, treat as delegation-failed and surface in UI |
| Ping / roll / bet on probe | wallet or session signer | `<Probe>` | ER `fqdn` from router | delegated + router-resolved | ER tx signature | ER-unavailable falls back to "probe offline" badge, no silent base-layer fallback |
| Commit / commit-and-undelegate | wallet | `<Probe>` | ER `fqdn` | delegated | `GetCommitmentSignature` resolves the base-layer finalization signature | poll with timeout; surface "settling" vs "settled" distinctly |
| VRF request | wallet, ER program identity | `VrfProbe`, oracle queue | ER `fqdn` (delegated queue) or Base (base queue) | probe delegated for ER path | request tx confirmed = accepted only | UI shows "requested" until callback lands; timeout after N slots marks "callback overdue" |
| VRF callback | MagicBlock VRF oracle (authenticated via `#[vrf_callback]`) | `VrfProbe` | wherever the request ran | request in flight | callback tx confirmed, `status = fulfilled` | duplicate callback is a no-op status-wise (idempotent by construction: status only advances forward) |
| Commit + Magic Action | wallet (escrow authority) | `ActionProbe`, `Milestone` | ER `fqdn`, base-layer action tx | probe delegated | dashboard confirms **both** the ER commit signature *and* observes `Milestone.high_value` change on base layer before marking "settled" | one failing BaseAction removes all BaseActions in that transaction strategy before commit retry; UI re-checks `Milestone` independently rather than trusting commit success alone |
| Schedule crank | wallet (task authority) | `CrankProbe` | ER `fqdn` | probe delegated | schedule tx accepted; dashboard separately polls `CrankProbe.count` to observe real iterations | reschedule/cancel by the same task authority; UI treats "scheduled" and "iterations observed" as distinct badges |
| Observe oracle price | anyone (read-only consumer) | `PriceProbe` | Base RPC | feed id configured | tx confirmed + `require!` freshness/positivity checks pass on-chain | stale/invalid feed reverts the tx; UI shows last-known-good with an explicit "stale" flag, never a silently reused value |
| Session grant / ping / revoke | wallet creates; session signer pings | `SessionProbe`, `SessionTokenV2` | Base RPC (grant/revoke), ER `fqdn` (ping) | session created on the connection the ER can read | session-scoped ER tx confirmed | expired/revoked session reverts on-chain (`SessionError::InvalidToken`), never only checked client-side |

## Delegation and settlement lifecycle

1. Initialize every probe account on base layer, funded by the connected wallet.
2. Delegate to a chosen region's Devnet ER validator; poll router `getDelegationStatus` until it resolves an `fqdn` before sending any ER transaction.
3. Operate (ping / roll / bet / observe) against that `fqdn`, timing every call client-side (`Date.now()` deltas, matching MagicBlock's own test-suite pattern) for the dashboard's live charts.
4. Commit periodically or on demand; use `GetCommitmentSignature` to time base-layer finalization separately from ER acceptance.
5. Commit-and-undelegate at the end of a demo run (or when the "reset" control is used) so accounts return to plain base-layer ownership and can be re-delegated cleanly for the next visitor.

## Security and operations

- Trust and privacy boundary: everything here is public-ER by default; the
  stretch PER probe is the only confidentiality boundary, and it is
  explicitly scoped to "prove the permission lifecycle works," not to hide
  real user data.
- Magic Actions: `probe-actions`'s `#[action]` handler requires the injected
  `escrow` account as a `signer` pinned to
  `ephemeral_balance_pda_from_payer(escrow_auth, 255)` — MagicBlock's own
  `magic-actions/anchor` reference example authenticates its equivalent
  handler with only `seeds`/`bump` on the target PDA, which (per MagicBlock's
  own security guidance for this exact pattern) does **not** authenticate the
  caller: anyone can invoke it directly on base layer with matching accounts.
  We close that gap and keep a separately-authorized direct instruction for
  legitimate non-action callers, per the "two thin instructions over one
  shared function" pattern.
- Sponsorship and funding: the connected wallet is the payer/escrow authority
  everywhere in this snapshot (no delegated fee-payer / fee-vault path — out
  of scope for a probe demo, called out in the fees-and-commit-economics
  reference as needed only past 10 commits without a vault).
- Failure and recovery: every async flow (VRF callback, crank iteration,
  Magic Action side-effect, commit finalization) is modeled and displayed as
  a distinct pending → observed state, never inferred from the initiating
  transaction's success alone — this mirrors the dev skill's composition
  guidance verbatim ("commit success is not proof that any scheduled Magic
  Action ran," "a successful request means the oracle accepted the work").
- Observability: the dashboard also polls MagicBlock's own
  `https://status.magicblock.app/api/services` for live region/service
  health, so "why is this probe stuck" has an answer beyond our own code.

## Validation plan

| Claim | Environment | Setup / command | Pass signal | Evidence retained | Not covered |
| --- | --- | --- | --- | --- | --- |
| Programs compile and pass anchor's own IDL build | Local (cargo/anchor) | `anchor build` | Clean build, `.so` + IDL emitted per program | Build log | On-chain behavior |
| Delegation lifecycle round-trips correctly | Devnet | `anchor test` against Devnet-connected provider (per `counter/anchor`'s test pattern) | init → delegate → ER ping → commit → undelegate all confirm | tx signatures, timing logs | Multi-region concurrency at scale |
| VRF request → callback completes and is idempotent | Devnet | scripted request + poll for `status=fulfilled` | callback lands, `request_count` increments exactly once per request | tx signatures | Oracle outage behavior |
| Magic Action side-effect actually lands on base layer | Devnet | `commit_and_update_milestone`, then independently fetch `Milestone` | `Milestone.high_value` reflects committed `ActionProbe.count` | before/after account fetch | Multi-action bundle partial-failure removal (documented, not exercised) |
| Crank iterations are observed, not assumed | Devnet | `schedule_ping`, poll `CrankProbe.count` over the scheduled interval | count increases roughly on-interval without further user txs | polled snapshots | Exact wall-clock timing guarantees |
| Oracle probe rejects stale/mismatched feeds | Devnet | call `observe_price` with a mismatched `feed_id` | tx reverts with `UnexpectedFeed` | tx error log | Live upstream outage |
| Session ping works without a wallet popup after grant | Devnet, browser | UI-driven session creation + N pings | pings confirm using the session signer only | tx signatures | SPL-token-delegate composition (not used here — no token spend in this probe) |

## Risks

- Devnet Ephemeral Rollup service availability during the judging window —
  mitigation: check `status.magicblock.app` before the live demo, keep a
  recorded fallback walkthrough.
- `ephemeral-rollups-sdk`'s `crank` feature is still git-pinned (not yet on
  crates.io as of this build) — mitigation: pin the exact revision MagicBlock's
  own example uses; treat as the highest-risk-of-drift dependency.
- Scope creep across six probes plus a stretch PER probe in an 8-day solo
  build — mitigation: the six core probes are independently shippable; PER
  is explicitly a cut-first stretch goal.
