# Deploying Mission Control's programs to devnet

This folder has everything needed to deploy the 6 probe programs - the
`.so` binaries are already built, so you do **not** need Rust/Anchor
installed locally, only the Solana CLI.

## Steps

1. Unzip this package somewhere on your machine (e.g. inside
   `C:\Users\Asus\source\`).
2. Open a real terminal you control directly - WSL, Git Bash, or a native
   Linux/macOS shell. Do not run this through any Claude-driven tool; it
   needs your machine's normal internet access.
3. `cd` into the unzipped `mission-control` folder.
4. Make the script executable and run it:
   ```bash
   chmod +x deploy-devnet.sh
   ./deploy-devnet.sh
   ```
5. If it stops because `solana` isn't installed, run the install command it
   prints, restart your terminal, and re-run the script.
6. Watch it go: wallet setup -> airdrop -> deploy all 6 programs. It writes
   everything to `deploy-log.txt` in this same folder as it runs.
7. Once it finishes (or if it fails partway), just leave `deploy-log.txt`
   where it is - I can read it directly and pick up from there, whether
   that means confirming success or fixing whatever went wrong.

## What's in this package

- `Anchor.toml`, `Cargo.toml` - workspace config, already pointed at the
  correct devnet program IDs.
- `programs/` - full Rust source for all 6 probes (core ER, VRF, Magic
  Actions, Crank, Price Oracle, Session Keys), for reference / future
  rebuilds.
- `target/deploy/*.so` - the compiled, ready-to-deploy program binaries.
- `target/deploy/*-keypair.json` - each program's on-chain address
  keypair (must stay paired with its `.so` - these are what make the
  deployed addresses match `Anchor.toml` and each program's own
  `declare_id!`).
- `target/idl/*.json` - Anchor IDLs the frontend will read directly
  (no on-chain IDL upload needed).
- `deploy-devnet.sh` - the one script to run.

## A note on cost

I believe deploying ~300KB programs costs roughly a few SOL each in
rent - so all 6 together could need somewhere in the ballpark of 10-15
devnet SOL. That's an estimate, not a guarantee, so keep an eye on
`solana balance` as the script runs. If the built-in airdrop rate-limits
you, top up manually at https://faucet.solana.com.
