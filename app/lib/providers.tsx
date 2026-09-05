"use client";

// Mission Control - client-side providers.
//
// Wraps the app in Solana's wallet-adapter context. Wallets array is
// intentionally empty: modern wallet-adapter auto-detects any
// Wallet-Standard-compliant extension (Phantom, Solflare, Backpack, ...)
// without needing per-wallet adapter packages.
//
// RPC endpoint: this is the one piece of Mission Control that genuinely
// needs live network access, and it gets it for free here - this code runs
// in the judge's/user's own browser, which (unlike any Claude-driven tool
// shell) has a completely normal path to the public internet.

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo, type ReactNode } from "react";
import { PUBLIC_DEVNET_RPC } from "./regions";
import { EventLogProvider } from "./event-log";

import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  const endpoint = PUBLIC_DEVNET_RPC;
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <EventLogProvider>{children}</EventLogProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
