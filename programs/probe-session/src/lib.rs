//! Mission Control - Session Keys probe.
//!
//! Demonstrates the wallet-or-session dual auth path: the dashboard first
//! pings using the real wallet (a signature popup each time), then creates a
//! session and pings again with the ephemeral session signer (no popups) so
//! the demo can show, side by side, the exact latency/UX difference session
//! keys buy you. `#[session_auth_or]` enforces on-chain that only the
//! wallet authority or a valid, unexpired, correctly-scoped session token for
//! that authority may call the hot path - the session token is validated by
//! the target program on every call, not merely presented.
//!
//! Adapted from MagicBlock's `session-keys/anchor` example
//! (magicblock-labs/magicblock-engine-examples, MIT licensed).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

declare_id!("UxGyQjXVBWXRwocPs1sjhV2BLWRmjwPc93yGVEn4XHd");

pub const SESSION_PROBE_SEED: &[u8] = b"session_probe";

#[ephemeral]
#[program]
pub mod probe_session {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        // See probe-vrf::initialize for why this guard exists: `init_if_needed`
        // does not skip this body on a pre-existing account, so without the
        // guard a repeat call wipes real ping history back to zero.
        if probe.authority != Pubkey::default() {
            return Ok(());
        }
        probe.authority = ctx.accounts.user.key();
        probe.ping_count = 0;
        Ok(())
    }

    /// Hot path, gated by wallet-or-session auth. Called once per wallet
    /// signature and, separately, many times per session signature in the
    /// demo so the UI can show "N pings, 1 popup."
    #[session_auth_or(
        ctx.accounts.probe.authority.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.ping_count = probe.ping_count.saturating_add(1);
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let authority = {
            let data = ctx.accounts.pda.try_borrow_data()?;
            SessionProbe::try_deserialize(&mut &data[..])?.authority
        };
        let session_ok = ctx
            .accounts
            .session_token
            .as_ref()
            .map(|t| t.authority == authority)
            .unwrap_or(false);
        require!(
            authority == ctx.accounts.payer.key() || session_ok,
            SessionError::InvalidToken
        );

        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[SESSION_PROBE_SEED, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.probe.authority.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn undelegate(ctx: Context<PingAndCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.probe.authority.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn ping_and_commit(ctx: Context<PingAndCommit>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.ping_count = probe.ping_count.saturating_add(1);
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
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + SessionProbe::SIZE,
        seeds = [SESSION_PROBE_SEED, user.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, SessionProbe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: deserialized manually in the handler; UncheckedAccount avoids
    /// Anchor re-serializing stale data after the delegate CPI transfers
    /// ownership to the delegation program.
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: validated in the handler against the probe's authority field.
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[derive(Accounts, Session)]
pub struct Ping<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SESSION_PROBE_SEED, probe.authority.key().as_ref()], bump)]
    pub probe: Account<'info, SessionProbe>,
    #[session(signer = payer, authority = probe.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[commit]
#[derive(Accounts, Session)]
pub struct PingAndCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SESSION_PROBE_SEED, probe.authority.key().as_ref()], bump)]
    pub probe: Account<'info, SessionProbe>,
    #[session(signer = payer, authority = probe.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[account]
pub struct SessionProbe {
    pub authority: Pubkey,
    pub ping_count: u64,
}

impl SessionProbe {
    pub const SIZE: usize = 32 + 8;
}
