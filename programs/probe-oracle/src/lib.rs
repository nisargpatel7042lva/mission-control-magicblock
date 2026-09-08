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
//! REAL BUG FOUND AND FIXED HERE, source-verified (not guessed) against
//! MagicBlock's own `real-time-pricing-oracle` repo and dev-skill
//! `debugging.md`: MagicBlock's Pricing Oracle republisher is ER-native by
//! design - its own README describes the service as injecting price feeds
//! "into ephemeral rollups", and its example SOL/USD account is linked via a
//! `customUrl=https://devnet.magicblock.app` explorer link, not a plain
//! base-layer one. That means the live feed account this probe reads
//! (`ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` in production use) is
//! normally delegated into a specific Ephemeral Rollup: on base layer its
//! owner is the Delegation Program (confirmed via a real
//! `AccountOwnedByWrongProgram`-shaped failure on real devnet, not assumed -
//! see `PYTH_RECEIVER_PROGRAM_ID`'s comment in `app/scripts/verify-e2e.js`),
//! and its real, current state exists only on that one ER.
//!
//! `ObservePrice::price_update` is a typed `Account<'info, PriceUpdateV2>`,
//! so Anchor's owner check fails outright whenever the runtime processing
//! the instruction doesn't already see the feed with its original owner -
//! which is exactly the case for every base-layer transaction while the
//! feed is delegated elsewhere. Per the pricing-oracle dev-skill reference
//! ("Make the feed available in that ER and read it there"), the fix is to
//! run `observe_price` on the SAME Ephemeral Rollup the feed is delegated
//! to, not on base layer. That requires `PriceProbe` itself to be
//! delegate-able so the whole transaction (probe + feed) is visible to one
//! runtime; the `delegate`/`commit`/`undelegate` instructions below add
//! exactly that, mirroring `probe-core`'s already-verified pattern. The
//! client (see `app/lib/router.ts`, `verify-e2e.js`'s `getDelegationStatus`)
//! discovers which validator the feed is currently on via MagicBlock's
//! router `getDelegationStatus` and pins this probe's delegation to that
//! same validator via `DelegateConfig.validator`.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2};

declare_id!("ELzCkEvf5EV6KVAQgvbuGyLZ9TJrfzvdCejKs6n85EPW");

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
        require!(
            ctx.accounts.price_update.price_message.feed_id == ctx.accounts.probe.feed_id,
            OracleProbeError::UnexpectedFeed
        );

        let price = read_verified_price(&ctx.accounts.price_update, &ctx.accounts.probe.feed_id)?;

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

    /// Delegate this probe to the Ephemeral Rollup validator currently
    /// hosting the live price feed it reads. Pass that validator's identity
    /// as the first remaining account (the client discovers it via router
    /// `getDelegationStatus` for the feed's `price_update` account - see the
    /// module doc comment above). Delegating to the wrong validator (or
    /// none, letting the delegation program pick a default) would put this
    /// probe on a different ER than the feed, where the feed is still not
    /// visible with its real owner - the whole point of this instruction is
    /// pinning both to the same runtime.
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

fn read_verified_price(price_update: &Account<PriceUpdateV2>, feed_id: &[u8; 32]) -> Result<Price> {
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
    /// The MagicBlock Pricing Oracle's republished feed account. Its address
    /// (not only its type) must be the one the application configured for
    /// this feed - checked here via the `feed_id` match, matching the
    /// consumer safety checklist. This same context runs unchanged on base
    /// layer or on an ER - Anchor's owner check only passes when the
    /// runtime it's actually processing on can see this account with its
    /// real (non-delegation-program) owner, which is why `delegate` above
    /// exists: pin `probe` to whichever ER `price_update` currently is.
    pub price_update: Account<'info, PriceUpdateV2>,
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
    #[msg("price feed account does not match the configured feed id")]
    UnexpectedFeed,
    #[msg("price update is stale, missing, or failed verification")]
    StaleOrInvalidPrice,
    #[msg("oracle price must be greater than zero")]
    NonPositivePrice,
}
