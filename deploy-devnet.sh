#!/usr/bin/env bash
# Mission Control - devnet deploy script.
#
# Run this yourself, in your OWN terminal (WSL / Git Bash / native Linux/macOS
# shell) - NOT through any Claude tool. It needs a real, unrestricted network
# path to Solana devnet, which your own terminal has and Claude's sandboxed
# tool shells do not.
#
# What it does:
#   1. Checks for the Solana CLI (does not install Rust/Anchor - the .so
#      binaries are already prebuilt, so you only need `solana`).
#   2. Creates (or reuses) a devnet wallet at ~/.config/solana/id.json.
#   3. Airdrops devnet SOL (rent for 6 programs, ~300KB each, adds up -
#      I believe you'll need roughly 10-15 SOL total across all deploys,
#      but please treat that as an estimate, not a guarantee - watch
#      `solana balance` and top up from https://faucet.solana.com if the
#      built-in `solana airdrop` rate-limits you).
#   4. Deploys all 6 programs with `solana program deploy`, using the
#      program keypairs already baked into target/deploy/ (these match the
#      IDs declared in each program's `declare_id!` and in Anchor.toml, so
#      don't regenerate them).
#   5. Writes a full transcript to deploy-log.txt in this same folder.
#
# After it finishes, just leave deploy-log.txt here - I can read it back
# directly (that's a plain file read, no network needed) to verify the
# deploy and keep building the rest of Mission Control.

set -euo pipefail
cd "$(dirname "$0")"

LOG="deploy-log.txt"
exec > >(tee "$LOG") 2>&1

echo "=== Mission Control devnet deploy ==="
date

echo
echo "== 1. Checking Solana CLI =="
if ! command -v solana &>/dev/null; then
  echo "solana CLI not found on PATH."
  echo "Install it with:"
  echo '  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
  echo "then re-open your terminal (or source your shell profile) and re-run this script."
  exit 1
fi
solana --version

echo
echo "== 2. Wallet =="
mkdir -p "$HOME/.config/solana"
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  echo "No wallet found - generating a fresh one."
  solana-keygen new --no-bip39-passphrase -o "$HOME/.config/solana/id.json"
else
  echo "Reusing existing wallet at ~/.config/solana/id.json"
fi
solana config set --url https://api.devnet.solana.com >/dev/null
solana config set --keypair "$HOME/.config/solana/id.json" >/dev/null
WALLET=$(solana address)
echo "Wallet address: $WALLET"

echo
echo "== 3. Requesting devnet SOL =="
for i in 1 2 3 4 5; do
  echo "-- airdrop attempt $i --"
  solana airdrop 2 || echo "(airdrop attempt failed/rate-limited, continuing)"
  sleep 3
done
echo "Current balance:"
solana balance

echo
echo "== 4. Deploying programs =="
PROGRAMS="probe_core probe_vrf probe_actions probe_crank probe_oracle probe_session"
for prog in $PROGRAMS; do
  echo
  echo "--- deploying $prog ---"
  SO="target/deploy/${prog}.so"
  KP="target/deploy/${prog}-keypair.json"
  if [ ! -f "$SO" ] || [ ! -f "$KP" ]; then
    echo "MISSING $SO or $KP - skipping"
    continue
  fi
  solana program deploy "$SO" \
    --program-id "$KP" \
    --url https://api.devnet.solana.com \
    --with-compute-unit-price 1000
done

echo
echo "== 5. Final program IDs (should match Anchor.toml) =="
for prog in $PROGRAMS; do
  KP="target/deploy/${prog}-keypair.json"
  if [ -f "$KP" ]; then
    printf "%-16s " "$prog"
    solana address -k "$KP"
  fi
done

echo
echo "== Done. Balance remaining: =="
solana balance

echo
echo "Transcript saved to $LOG"
