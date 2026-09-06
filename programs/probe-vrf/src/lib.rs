//! Mission Control - VRF probe.
//!
//! Times the two-phase VRF flow: `request_randomness` (accepted into the
//! oracle queue) and the asynchronous, authenticated `consume_randomness`
//! callback that actually delivers the outcome. These are genuinely
//! separate observable states - a successful request only proves the oracle
//! accepted the work, so the dashboard tracks `status` through
//! Idle -> Requested -> Fulfilled and reports the request->callback latency,
//! never inferring fulfillment from request success.
//!
//! Runs against the delegated (ephemeral) oracle queue while the probe
//! account is delegated to an ER, so both the dice roll and the randomness
//! round-trip happen at ER speed.
//!
//! Adapted from MagicBlock's `roll-dice/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("EzQLQDFAapDwyHnPsv9PUnt4mEbrLPfgnpBJmeu766fT");

pub const VRF_PROBE_SEED: &[u8] = b"vrf_probe";

/// idle=0, requested=1, fulfilled=2. Mirrors the request lifecycle state
/// machine the MagicBlock VRF guide calls for (idle -> requested -> fulfilled).
pub const STATUS_IDLE: u8 = 0;
pub const STATUS_REQUESTED: u8 = 1;
pub const STATUS_FULFILLED: u8 = 2;

#[ephemeral]
#[program]
pub mod probe_vrf {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        // `init_if_needed` only skips the account-creation CPI when the PDA
        // already exists - it does NOT skip this function body. Without this
        // guard, re-clicking "Initialize" on an already-active probe would
        // silently wipe its accumulated request/fulfillment history back to
        // defaults. Solana zero-initializes new account data, so a real
        // owner pubkey is never `Pubkey::default()` - that's the reliable
        // "is this actually fresh?" check.
        if probe.owner != Pubkey::default() {
            return Ok(());
        }
        probe.owner = ctx.accounts.payer.key();
        probe.status = STATUS_IDLE;
        probe.last_result = 0;
        probe.request_count = 0;
        probe.requested_at_slot = 0;
        probe.fulfilled_at_slot = 0;
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[VRF_PROBE_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Request randomness. Reject a second in-flight request unless the
    /// previous one was fulfilled, so one callback can't be misattributed to
    /// a later request.
    pub fn request_randomness(ctx: Context<RequestRandomnessCtx>, client_seed: u8) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        require!(probe.status != STATUS_REQUESTED, VrfProbeError::RequestInFlight);

        probe.status = STATUS_REQUESTED;
        probe.requested_at_slot = Clock::get()?.slot;

        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.probe.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(vec![client_seed]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Oracle-authenticated callback. `#[vrf_callback]` binds
    /// `vrf_program_identity` to this program's scoped VRF identity, so a
    /// caller cannot spoof fulfillment.
    pub fn consume_randomness(
        ctx: Context<ConsumeRandomnessCtx>,
        randomness: [u8; 32],
        _client_seed: u8,
    ) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.last_result = vrf::rnd::random_u8_with_range(&randomness, 1, 100);
        probe.status = STATUS_FULFILLED;
        probe.fulfilled_at_slot = Clock::get()?.slot;
        probe.request_count = probe.request_count.saturating_add(1);
        Ok(())
    }

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

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + VrfProbe::SIZE,
        seeds = [VRF_PROBE_SEED, payer.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, VrfProbe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the VRF probe PDA being delegated.
    #[account(mut, del, seeds = [VRF_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRandomnessCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: Account<'info, VrfProbe>,
    /// CHECK: must be the base-layer `DEFAULT_QUEUE`/`DEFAULT_TEST_QUEUE` when
    /// called from base layer, or the delegated
    /// `DEFAULT_EPHEMERAL_QUEUE`/`DEFAULT_EPHEMERAL_TEST_QUEUE` when called
    /// from inside the ER - whichever runtime this instruction executes in.
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf::consts::DEFAULT_QUEUE ||
            oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE ||
            oracle_queue.key() == vrf::consts::DEFAULT_TEST_QUEUE ||
            oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_TEST_QUEUE
            @ VrfProbeError::InvalidOracleQueue
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRandomnessCtx<'info> {
    #[account(mut)]
    pub probe: Account<'info, VrfProbe>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOrUndelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: Account<'info, VrfProbe>,
}

#[account]
pub struct VrfProbe {
    pub owner: Pubkey,
    pub status: u8,
    pub last_result: u8,
    pub request_count: u64,
    pub requested_at_slot: u64,
    pub fulfilled_at_slot: u64,
}

impl VrfProbe {
    pub const SIZE: usize = 32 + 1 + 1 + 8 + 8 + 8;
}

#[error_code]
pub enum VrfProbeError {
    #[msg("a randomness request is already in flight for this probe")]
    RequestInFlight,
    #[msg("oracle queue does not match a known base-layer or delegated queue")]
    InvalidOracleQueue,
}
