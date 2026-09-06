//! Mission Control - ER core probe.
//!
//! Demonstrates and times the full Ephemeral Rollup lifecycle for a single
//! account: delegate (base layer) -> ping (ER, sub-50ms) -> commit (ER) ->
//! undelegate (ER). The frontend drives this from multiple regions
//! (Asia / EU / US / TEE) to build the live latency map, following the same
//! Date.now()-delta pattern MagicBlock's own examples use in their test
//! suites, plus `GetCommitmentSignature` to time base-layer commit
//! finalization.
//!
//! Adapted from MagicBlock's `counter/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed) with a
//! monitoring-oriented account shape (ping_count / last_value / slot
//! bookkeeping) instead of a bare counter.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("96ru2VBdLyqvtvVTwgAKs9e4k8DVqpero5dHvXTVkfEA");

pub const PROBE_SEED: &[u8] = b"probe";

#[ephemeral]
#[program]
pub mod probe_core {
    use super::*;

    /// Initialize a probe account owned by `user`. One probe per
    /// (owner, label) pair so the dashboard can run several concurrent
    /// probes (e.g. one per region) without colliding.
    pub fn initialize(ctx: Context<Initialize>, label: [u8; 16]) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        // See probe-vrf::initialize for why this guard exists: `init_if_needed`
        // does not skip this body on a pre-existing account, so without the
        // guard a repeat call wipes real ping/commit history back to zero.
        if probe.owner != Pubkey::default() {
            return Ok(());
        }
        probe.owner = ctx.accounts.user.key();
        probe.label = label;
        probe.ping_count = 0;
        probe.last_value = 0;
        probe.last_updated_slot = Clock::get()?.slot;
        Ok(())
    }

    /// The hot path: mutate state as fast as the runtime allows. On the ER
    /// this executes in ~10-50ms; on base layer it takes a full Solana slot
    /// (~400ms). The frontend times this call directly.
    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.ping_count = probe.ping_count.saturating_add(1);
        probe.last_value = probe.last_value.wrapping_add(1);
        probe.last_updated_slot = Clock::get()?.slot;
        Ok(())
    }

    /// Delegate the probe PDA to an Ephemeral Rollup validator. Pass the
    /// target validator's identity as the first remaining account (region
    /// selection happens here).
    ///
    /// The seeds passed to `delegate_pda` must exactly reconstruct this
    /// account's real PDA derivation (`[PROBE_SEED, owner, label]` from
    /// `Initialize`) - the delegation CPI uses them as `invoke_signed`
    /// signer seeds for the account itself, so anything else fails on-chain
    /// with a signer-mismatch error. `DelegateInput` only carries `payer`
    /// and the untyped `pda`, so `owner`/`label` are read back out of the
    /// account's own data first, mirroring `probe_session::delegate`.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let (owner, label) = {
            let data = ctx.accounts.pda.try_borrow_data()?;
            let probe = Probe::try_deserialize(&mut &data[..])?;
            (probe.owner, probe.label)
        };
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[PROBE_SEED, owner.as_ref(), label.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Manually commit current ER state back to the base layer without
    /// releasing delegation (probe keeps running on the ER afterwards).
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

    /// Commit + release delegation, returning the account to pure base-layer
    /// ownership. This is the terminal step of one probe cycle.
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

    /// Convenience: ping + commit in one ER transaction (used by the
    /// "stress test" burst mode so each round trip is a single signature).
    pub fn ping_and_commit(ctx: Context<CommitOrUndelegate>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.ping_count = probe.ping_count.saturating_add(1);
        probe.last_value = probe.last_value.wrapping_add(1);
        probe.last_updated_slot = Clock::get()?.slot;
        probe.exit(&crate::ID)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Convenience: ping + commit + undelegate in one ER transaction.
    pub fn ping_and_undelegate(ctx: Context<CommitOrUndelegate>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.ping_count = probe.ping_count.saturating_add(1);
        probe.last_value = probe.last_value.wrapping_add(1);
        probe.last_updated_slot = Clock::get()?.slot;
        probe.exit(&crate::ID)?;

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

#[derive(Accounts)]
#[instruction(label: [u8; 16])]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Probe::SIZE,
        seeds = [PROBE_SEED, user.key().as_ref(), label.as_ref()],
        bump
    )]
    pub probe: Account<'info, Probe>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the probe PDA being delegated.
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Ping<'info> {
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOrUndelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}

#[account]
pub struct Probe {
    pub owner: Pubkey,
    pub label: [u8; 16],
    pub ping_count: u64,
    pub last_value: u64,
    pub last_updated_slot: u64,
}

impl Probe {
    pub const SIZE: usize = 32 + 16 + 8 + 8 + 8;
}
