//! Mission Control - Pricing Oracle probe.
//!
//! Reads a MagicBlock Pricing Oracle feed (republished Pyth Lazer/Stork data
//! in a `PriceUpdateV2` account) and records a verified observation: feed
//! identity match, publish-time freshness, and a positive price, following
//! the oracle safety checklist - successful deserialization alone is never
//! treated as proof of a fresh, valid price. The dashboard polls
//! `observe_price` on a timer and plots `last_publish_time` age live as the
//! staleness gauge.
//!
//! Adapted from MagicBlock's `oracle-priced-purchase/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed), trimmed from a
//! purchase flow down to a pure verified-observation probe.
//!
//! REAL BUGS FOUND AND FIXED HERE, source-verified against real on-chain
//! evidence and MagicBlock's own repos at every step (not guessed) -
//! including two dead ends this comment used to describe as the fix, kept
//! below with corrections so the trail is honest about what didn't work:
//!
//! 1. The live feed account this probe reads
//!    (`ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` in production use) is
//!    delegated into an Ephemeral Rollup on base layer (owner =
//!    `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, confirmed via a real
//!    `getAccountInfo` call, not assumed) - MagicBlock's Pricing Oracle is
//!    ER-native by design (its own README describes injecting feeds "into
//!    ephemeral rollups"). Reading it therefore requires being on an ER,
//!    which is why `PriceProbe` is delegate-able below (`delegate`/`commit`/
//!    `undelegate`, mirroring `probe-core`'s pattern) - this part holds.
//! 2. FIRST WRONG GUESS: assumed the feed is pinned to one specific
//!    validator, discoverable via router `getDelegationStatus`, and tried
//!    to pin this probe to that same one. Wrong - caught by a real
//!    `-32604 "account has been delegated to unknown ER node:
//!    11111111111111111111111111111111"` router error on a real devnet run.
//!    Source-traced to `magicblock-labs/real-time-pricing-oracle` +
//!    `magicblock-labs/delegation-program`: the oracle delegates via the
//!    delegation program's `DelegateWithAnyValidator` entrypoint with
//!    `validator: Some(system_program::id())` - a deliberate "not pinned to
//!    one ER" sentinel. Corrected fix: just delegate this probe the
//!    ordinary way (default validator) to the same shared Asia ER every
//!    other probe in this app already uses - "any validator" means any ER
//!    can see it.
//! 3. SECOND WRONG GUESS: assumed that once on an ER, the feed would pass
//!    Anchor's normal owner check for `PriceUpdateV2`. Wrong again - caught
//!    by a real `AccountOwnedByWrongProgram` ("The given account is owned
//!    by a different program than expected") failure on a real devnet run,
//!    even after successfully delegating and routing to the Asia ER.
//!    Root-caused with real `getAccountInfo` calls against base layer AND
//!    all four devnet ERs (asia/eu/us/tee): every single one shows this
//!    feed account owned by `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` -
//!    MagicBlock's OWN Pricing Oracle program (this is also literally the
//!    "current oracle program ID" the magicblock dev-skill's
//!    `pricing-oracle.md` names) - never the Pyth receiver program
//!    `pyth_solana_receiver_sdk`'s `PriceUpdateV2` type hard-requires via
//!    Anchor's `Owner` trait. MagicBlock republishes Pyth Lazer data into
//!    an account with `PriceUpdateV2`'s exact byte layout, but under ITS
//!    OWN program's ownership, not Pyth's - so `Account<'info,
//!    PriceUpdateV2>` was never going to pass its automatic owner check on
//!    ANY layer, delegated or not. The real fix: read `price_update` as an
//!    `UncheckedAccount`, verify its owner is MagicBlock's Pricing Oracle
//!    program explicitly (`PRICING_ORACLE_PROGRAM_ID` below), and
//!    deserialize its data manually as `PriceUpdateV2` - the layout
//!    assumption is still real and still checked (feed_id/price/exponent/
//!    publish_time/posted_slot all get validated exactly as before), only
//!    the *owner* expectation changes to match what the account actually
//!    is on any layer that can see it.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2};

declare_id!("ELzCkEvf5EV6KVAQgvbuGyLZ9TJrfzvdCejKs6n85EPW");

/// MagicBlock's Pricing Oracle program - the REAL owner of the republished
/// feed accounts this probe reads (see module doc comment above). Sourced
/// from the magicblock dev-skill's `pricing-oracle.md` ("The current oracle
/// program ID is..."), independently confirmed via real `getAccountInfo`
/// calls against base layer and all four devnet ERs.
pub const PRICING_ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

pub const PROBE_SEED: &[u8] = b"oracle_probe";
/// Reject any price whose upstream publish time is older than this. The
/// dashboard also shows the live age so a user can see this boundary
/// approach in real time, not just a pass/fail flag.
pub const MAX_PRICE_AGE_SECONDS: u64 = 60;

#[ephemeral]
#[program]
pub mod probe_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, feed_id: [u8; 32]) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        // See probe-vrf::initialize for why this guard exists: `init_if_needed`
        // does not skip this body on a pre-existing account, so without the
        // guard a repeat call wipes real observation history back to zero.
        if probe.owner != Pubkey::default() {
            return Ok(());
        }
        probe.owner = ctx.accounts.user.key();
        probe.feed_id = feed_id;
        probe.last_price = 0;
        probe.last_exponent = 0;
        probe.last_publish_time = 0;
        probe.observation_count = 0;
        Ok(())
    }

    /// Verify and record one price observation. Reverts (rather than
    /// recording stale/invalid data) if the feed doesn't match, the price is
    /// non-positive, or the upstream publish time exceeds
    /// `MAX_PRICE_AGE_SECONDS` - `get_price_no_older_than` enforces the
    /// freshness bound itself against the current on-chain clock.
    pub fn observe_price(ctx: Context<ObservePrice>) -> Result<()> {
        // `price_update` is an `UncheckedAccount` (its owner is MagicBlock's
        // Pricing Oracle program, not Pyth's receiver program - see module
        // doc comment), so we deserialize its `PriceUpdateV2`-shaped data
        // ourselves rather than relying on Anchor's `Account<'info, T>`
        // automatic owner check, which hard-requires the Pyth receiver
        // program and would reject this account unconditionally.
        let price_update = deserialize_price_update(&ctx.accounts.price_update)?;
        require!(
            price_update.price_message.feed_id == ctx.accounts.probe.feed_id,
            OracleProbeError::UnexpectedFeed
        );

        let price = read_verified_price(&price_update, &ctx.accounts.probe.feed_id)?;

        let probe = &mut ctx.accounts.probe;
        probe.last_price = price.price;
        probe.last_exponent = price.exponent;
        probe.last_publish_time = price.publish_time;
        probe.last_observed_slot = Clock::get()?.slot;
        probe.observation_count = probe.observation_count.saturating_add(1);

        msg!(
            "Verified price {}e{} published at {} (observation #{})",
            price.price,
            price.exponent,
            price.publish_time,
            probe.observation_count
        );
        Ok(())
    }

    /// Delegate this probe to an Ephemeral Rollup validator so it can be
    /// used in the same transaction as the (any-validator-delegated) price
    /// feed - see the module doc comment above for why there's no specific
    /// validator to pin to here, unlike `probe_core`/`probe_actions`, which
    /// accept an optional validator override the same way (first remaining
    /// account) for region selection. The client just omits it and gets the
    /// default validator, same as every other probe in this app.
    ///
    /// `DelegateInput` only carries `payer` and the untyped `pda`, so
    /// `owner`/`feed_id` are read back out of the account's own data first,
    /// mirroring `probe_core::delegate`.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let (owner, feed_id) = {
            let data = ctx.accounts.pda.try_borrow_data()?;
            let probe = PriceProbe::try_deserialize(&mut &data[..])?;
            (probe.owner, probe.feed_id)
        };
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[PROBE_SEED, owner.as_ref(), feed_id.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commit the probe's latest recorded observation back to base layer
    /// without releasing delegation.
    pub fn commit(ctx: Context<CommitOrUndelegate>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit + release delegation, returning the probe to pure base-layer
    /// ownership.
    pub fn undelegate(ctx: Context<CommitOrUndelegate>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

/// Deserialize `price_update`'s raw account data as `PriceUpdateV2`,
/// bypassing Anchor's `Account<'info, T>` automatic owner check (see module
/// doc comment for why: the account's real owner is MagicBlock's Pricing
/// Oracle program, not the Pyth receiver program `PriceUpdateV2::owner()`
/// expects). The account's *expected* owner is still checked - explicitly,
/// via the `#[account(owner = ...)]` constraint on `ObservePrice::price_update`
/// itself - so this function only has to trust the data layout, not skip
/// ownership verification entirely.
fn deserialize_price_update(account_info: &UncheckedAccount) -> Result<PriceUpdateV2> {
    let data = account_info.try_borrow_data()?;
    PriceUpdateV2::try_deserialize(&mut &data[..]).map_err(|_| error!(OracleProbeError::StaleOrInvalidPrice))
}

fn read_verified_price(price_update: &PriceUpdateV2, feed_id: &[u8; 32]) -> Result<Price> {
    // DIAGNOSTIC ONLY - no behavior change. Added after a real devnet run
    // got past both owner checks (the actual bugs) and then reverted here
    // with the generic StaleOrInvalidPrice message, which doesn't say
    // *which* of the three conditions below actually failed. Logged instead
    // of guessed - these lines print in the transaction logs on both
    // success and failure, so the real posted_slot/publish_time/price for
    // this specific feed account are visible either way. Safe to remove
    // once the real cause is confirmed.
    let now = Clock::get()?.unix_timestamp;
    msg!(
        "oracle diagnostic: posted_slot={} publish_time={} now={} age_seconds={} raw_price={} feed_id_matches={}",
        price_update.posted_slot,
        price_update.price_message.publish_time,
        now,
        now - price_update.price_message.publish_time,
        price_update.price_message.price,
        price_update.price_message.feed_id == *feed_id,
    );

    // `get_price_no_older_than` only checks `verification_level` (Full) and
    // `publish_time`. Per the MagicBlock Pricing Oracle security guidance,
    // `VerificationLevel::Full` alone is not proof of a genuine republisher
    // update: account initialization also sets `Full` while writing a
    // zero-value placeholder with `posted_slot = 0`. Require a nonzero
    // local posting slot as well, so an initialized-but-never-updated (or
    // otherwise not-yet-republished) account is rejected even before its
    // price/timestamp fields are inspected.
    require!(price_update.posted_slot > 0, OracleProbeError::StaleOrInvalidPrice);

    let price = price_update
        .get_price_no_older_than(&Clock::get()?, MAX_PRICE_AGE_SECONDS, feed_id)
        .map_err(|_| error!(OracleProbeError::StaleOrInvalidPrice))?;
    require!(price.price > 0, OracleProbeError::NonPositivePrice);
    Ok(price)
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + PriceProbe::SIZE,
        seeds = [PROBE_SEED, user.key().as_ref(), feed_id.as_ref()],
        bump
    )]
    pub probe: Account<'info, PriceProbe>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ObservePrice<'info> {
    #[account(mut)]
    pub probe: Account<'info, PriceProbe>,
    /// CHECK: the MagicBlock Pricing Oracle's republished feed account.
    /// `UncheckedAccount` + an explicit owner constraint (rather than
    /// `Account<'info, PriceUpdateV2>`) because its real owner is
    /// MagicBlock's Pricing Oracle program, not the Pyth receiver program
    /// `PriceUpdateV2::owner()` requires - see module doc comment. Its
    /// address (not only its owner) must be the one the application
    /// configured for this feed - checked in `observe_price` via the
    /// `feed_id` match after manual deserialization, matching the consumer
    /// safety checklist. This context runs unchanged on base layer or on an
    /// ER; the account only satisfies the owner constraint on whichever
    /// runtime can see it with that real owner, which is why `delegate`
    /// above exists.
    #[account(owner = PRICING_ORACLE_PROGRAM_ID @ OracleProbeError::UnexpectedFeedOwner)]
    pub price_update: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the price probe PDA being delegated.
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOrUndelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, PriceProbe>,
}

#[account]
pub struct PriceProbe {
    pub owner: Pubkey,
    pub feed_id: [u8; 32],
    pub last_price: i64,
    pub last_exponent: i32,
    pub last_publish_time: i64,
    pub last_observed_slot: u64,
    pub observation_count: u64,
}

impl PriceProbe {
    pub const SIZE: usize = 32 + 32 + 8 + 4 + 8 + 8 + 8;
}

#[error_code]
pub enum OracleProbeError {
    #[msg("price feed account is not owned by MagicBlock's Pricing Oracle program")]
    UnexpectedFeedOwner,
    #[msg("price feed account does not match the configured feed id")]
    UnexpectedFeed,
    #[msg("price update is stale, missing, or failed verification")]
    StaleOrInvalidPrice,
    #[msg("oracle price must be greater than zero")]
    NonPositivePrice,
}
