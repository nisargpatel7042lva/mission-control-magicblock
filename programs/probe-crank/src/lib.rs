//! Mission Control - Crank probe.
//!
//! Schedules a recurring ER-local task (`ping`) via `ScheduleCrankCpi` and
//! tracks how many iterations have actually executed versus how many were
//! requested, so the dashboard can show "scheduled" vs "observed applied"
//! as distinct states - a successful schedule transaction only means the
//! scheduler accepted the request, not that it has registered or run it yet.
//!
//! Adapted from MagicBlock's `crank-counter/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("gzNGTCNmCBfxGJL5t5XExoeHsB9ooc4LUubZ41Po86K");

pub const CRANK_PROBE_SEED: &[u8] = b"crank_probe";

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[ephemeral]
#[program]
pub mod probe_crank {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        // See probe-vrf::initialize for why this guard exists: `init_if_needed`
        // does not skip this body on a pre-existing account, so without the
        // guard a repeat call wipes real scheduling history back to zero.
        if probe.owner != Pubkey::default() {
            return Ok(());
        }
        probe.owner = ctx.accounts.user.key();
        probe.count = 0;
        probe.task_id = 0;
        probe.last_scheduled_slot = 0;
        Ok(())
    }

    /// Manual ping, for a side-by-side "manual vs cranked" comparison.
    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.count = probe.count.saturating_add(1);
        Ok(())
    }

    /// Ask the ER scheduler to call `ping` on an interval, `iterations` times.
    /// `task_id` must be globally unique per validator instance - derived
    /// here from the probe's own address so two probes never collide.
    pub fn schedule_ping<'info>(
        ctx: Context<'info, ScheduleCrank<'info>>,
        args: ScheduleArgs,
    ) -> Result<()> {
        let ping_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.probe.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Ping {}),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.probe.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![ping_ix],
            },
        }
        .invoke()?;

        // Record scheduling *request* metadata; the dashboard separately
        // polls `count` to observe whether iterations are actually landing.
        let probe_info = ctx.accounts.probe.to_account_info();
        let mut data = probe_info.try_borrow_mut_data()?;
        let mut probe = CrankProbe::try_deserialize(&mut &data[..])?;
        probe.task_id = args.task_id;
        probe.last_scheduled_slot = Clock::get()?.slot;
        probe.try_serialize(&mut *data)?;
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[CRANK_PROBE_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
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
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + CrankProbe::SIZE,
        seeds = [CRANK_PROBE_SEED, user.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, CrankProbe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the crank probe PDA being delegated.
    #[account(mut, del, seeds = [CRANK_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Ping<'info> {
    #[account(mut)]
    pub probe: Account<'info, CrankProbe>,
}

#[derive(Accounts)]
pub struct ScheduleCrank<'info> {
    /// CHECK: used for CPI.
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: passed to CPI - UncheckedAccount avoids Anchor re-serializing
    /// stale data after the CPI; this handler re-reads/writes it manually.
    #[account(mut, seeds = [CRANK_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: used for CPI.
    pub program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOrUndelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CRANK_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: Account<'info, CrankProbe>,
}

#[account]
pub struct CrankProbe {
    pub owner: Pubkey,
    pub count: u64,
    pub task_id: i64,
    pub last_scheduled_slot: u64,
}

impl CrankProbe {
    pub const SIZE: usize = 32 + 8 + 8 + 8;
}
