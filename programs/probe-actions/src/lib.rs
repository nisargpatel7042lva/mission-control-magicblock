//! Mission Control - Magic Actions probe.
//!
//! Times the "ER commit -> base-layer side-effect" round trip: pinging a
//! delegated `ActionProbe` on the ER, then committing it with a Magic Action
//! attached that updates a plain base-layer `Milestone` PDA the instant the
//! commit seals - no separate user transaction or relayer.
//!
//! Security note: MagicBlock's own `magic-actions/anchor` reference example
//! authenticates `update_leaderboard` with only `seeds`/`bump` on the
//! leaderboard PDA, which - per MagicBlock's own security guidance for this
//! feature - does *not* authenticate the caller: anyone can invoke that
//! instruction directly on base layer with matching accounts, since address
//! and seed constraints only pin *which* accounts are passed, not *who*
//! called. This probe instead requires the injected `escrow` account as a
//! `signer` pinned to `ephemeral_balance_pda_from_payer(escrow_auth, 255)` -
//! only the delegation program can sign for that PDA, so its presence is the
//! one fact proving the call actually arrived through the real post-commit
//! path - and keeps a separate, normally-authorized direct instruction for
//! callers who aren't a post-commit action.
//!
//! Adapted from MagicBlock's `magic-actions/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer;
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

declare_id!("63pMnDypD8SVayKfXz1HbHjbQW1caX82UPRgsK4wSegh");

pub const ACTION_PROBE_SEED: &[u8] = b"action_probe";
pub const MILESTONE_SEED: &[u8] = b"milestone";
/// Default `escrow_index` used by `ActionArgs::new` / `CallHandler`.
pub const ACTION_ESCROW_INDEX: u8 = 255;

#[ephemeral]
#[program]
pub mod probe_actions {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // See probe-vrf::initialize for why these guards exist: `init_if_needed`
        // does not skip this body on a pre-existing account, so without them a
        // repeat call wipes real ping/milestone history back to zero. Each
        // account is guarded independently since they're distinct PDAs.
        //
        // This also fixes a separate latent bug: `milestone.owner` was never
        // set here at all, so it stayed `Pubkey::default()` forever and
        // `update_milestone_direct`'s `has_one = owner` constraint could
        // never be satisfied by any real wallet signer.
        if ctx.accounts.probe.owner == Pubkey::default() {
            ctx.accounts.probe.owner = ctx.accounts.user.key();
            ctx.accounts.probe.count = 0;
        }
        if ctx.accounts.milestone.owner == Pubkey::default() {
            ctx.accounts.milestone.owner = ctx.accounts.user.key();
            ctx.accounts.milestone.high_value = 0;
        }
        Ok(())
    }

    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.count = probe.count.saturating_add(1);
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[ACTION_PROBE_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn undelegate(ctx: Context<CommitOnly>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit the ER probe and, in the same base-layer transaction attempt,
    /// schedule the `update_milestone` action against the freshly committed
    /// state. `escrow_authority` is the user's wallet, so this is a
    /// user-paid action (`build_and_invoke`, not `_signed`).
    pub fn commit_and_update_milestone(ctx: Context<CommitAndAction>) -> Result<()> {
        let instruction_data =
            anchor_lang::InstructionData::data(&crate::instruction::UpdateMilestone {});
        let action_args = ActionArgs::new(instruction_data);
        let action_accounts = vec![
            ShortAccountMeta {
                pubkey: ctx.accounts.milestone.key().to_bytes().into(),
                is_writable: true,
            },
            ShortAccountMeta {
                pubkey: ctx.accounts.probe.key().to_bytes().into(),
                is_writable: false,
            },
        ];
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: action_accounts,
            args: action_args,
            escrow_authority: ctx.accounts.payer.to_account_info(),
            compute_units: 200_000,
        };

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.probe.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        Ok(())
    }

    /// Post-commit action entrypoint. Only reachable through the real
    /// post-commit path because `escrow` must be a signer pinned to the
    /// escrow PDA derived from `escrow_auth` - see the `UpdateMilestoneAction`
    /// accounts struct.
    pub fn update_milestone(ctx: Context<UpdateMilestoneAction>) -> Result<()> {
        apply_milestone_update(&mut ctx.accounts.milestone, &ctx.accounts.probe)
    }

    /// Direct, wallet-authorized path for the identical logic (e.g. an admin
    /// forcing a resync). Kept as a separate instruction rather than folding
    /// escrow checks into `update_milestone` itself, per the "two thin
    /// instructions over one shared function" pattern - each entrypoint
    /// carries exactly the authentication it needs.
    pub fn update_milestone_direct(ctx: Context<UpdateMilestoneDirect>) -> Result<()> {
        apply_milestone_update(&mut ctx.accounts.milestone, &ctx.accounts.probe)
    }
}

fn apply_milestone_update(milestone: &mut Account<Milestone>, probe: &UncheckedAccount) -> Result<()> {
    let data: &[u8] = &probe.try_borrow_data()?;
    let probe_state = ActionProbe::try_deserialize(&mut &data[..])?;
    if probe_state.count > milestone.high_value {
        milestone.high_value = probe_state.count;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + ActionProbe::SIZE,
        seeds = [ACTION_PROBE_SEED, user.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, ActionProbe>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Milestone::SIZE,
        seeds = [MILESTONE_SEED, user.key().as_ref()],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the action probe PDA being delegated.
    #[account(mut, del, seeds = [ACTION_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Ping<'info> {
    #[account(mut)]
    pub probe: Account<'info, ActionProbe>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOnly<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, ActionProbe>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndAction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ACTION_PROBE_SEED, payer.key().as_ref()], bump)]
    pub probe: Account<'info, ActionProbe>,
    /// CHECK: Milestone PDA - writable flag is set inside the action accounts list.
    #[account(seeds = [MILESTONE_SEED, payer.key().as_ref()], bump)]
    pub milestone: UncheckedAccount<'info>,
    /// CHECK: destination program for the scheduled base-layer action.
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

/// Hardened `#[action]` context: `escrow` must sign, and must equal the
/// escrow PDA derived from `escrow_auth` - the only accounts the delegation
/// program itself can make true. This is the authentication a bare
/// `seeds`/`bump` constraint on `milestone` cannot provide.
#[action]
#[derive(Accounts)]
pub struct UpdateMilestoneAction<'info> {
    #[account(mut)]
    pub milestone: Account<'info, Milestone>,
    /// CHECK: read via manual deserialization in `apply_milestone_update`;
    /// owner is the delegation program while still delegated, or this
    /// program once undelegated. Seeds pin it to the same user as
    /// `milestone` regardless of which program currently owns it.
    #[account(seeds = [ACTION_PROBE_SEED, milestone.owner.as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: payer identity the action was scheduled with (the user wallet
    /// for this user-paid flow).
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: only the delegation program can sign for this PDA, so `signer`
    /// proves the call arrived through the real post-commit path.
    #[account(
        signer @ ActionProbeError::Unauthorized,
        address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX)
            @ ActionProbeError::Unauthorized,
    )]
    pub escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateMilestoneDirect<'info> {
    #[account(mut, has_one = owner @ ActionProbeError::Unauthorized)]
    pub milestone: Account<'info, Milestone>,
    /// CHECK: read via manual deserialization; seeds pin it to the same user.
    #[account(seeds = [ACTION_PROBE_SEED, owner.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    pub owner: Signer<'info>,
}

#[account]
pub struct ActionProbe {
    pub owner: Pubkey,
    pub count: u64,
}

impl ActionProbe {
    pub const SIZE: usize = 32 + 8;
}

#[account]
pub struct Milestone {
    pub owner: Pubkey,
    pub high_value: u64,
}

impl Milestone {
    pub const SIZE: usize = 32 + 8;
}

#[error_code]
pub enum ActionProbeError {
    #[msg("caller did not arrive through the authenticated post-commit action path")]
    Unauthorized,
}
