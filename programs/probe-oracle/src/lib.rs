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

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2};

declare_id!("ELzCkEvf5EV6KVAQgvbuGyLZ9TJrfzvdCejKs6n85EPW");

pub const PROBE_SEED: &[u8] = b"oracle_probe";
/// Reject any price whose upstream publish time is older than this. The
/// dashboard also shows the live age so a user can see this boundary
/// approach in real time, not just a pass/fail flag.
pub const MAX_PRICE_AGE_SECONDS: u64 = 60;

#[program]
pub mod probe_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, feed_id: [u8; 32]) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
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
}

fn read_verified_price(price_update: &Account<PriceUpdateV2>, feed_id: &[u8; 32]) -> Result<Price> {
    // get_price_no_older_than only checks verification_level (Full) and
    // publish_time. Per the MagicBlock Pricing Oracle security guidance,
    // VerificationLevel::Full alone is not proof of a genuine republisher
    // update: account initialization also sets Full while writing a
    // zero-value placeholder with posted_slot = 0. Require a nonzero
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
    /// consumer safety checklist.
    pub price_update: Account<'info, PriceUpdateV2>,
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
