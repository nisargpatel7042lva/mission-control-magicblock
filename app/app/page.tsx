"use client";

import dynamic from "next/dynamic";
import { StatusStrip } from "@/components/StatusStrip";
import { EventTimeline } from "@/components/EventTimeline";
import { CoreProbePanel } from "@/components/probes/CoreProbePanel";
import { VrfProbePanel } from "@/components/probes/VrfProbePanel";
import { ActionsProbePanel } from "@/components/probes/ActionsProbePanel";
import { CrankProbePanel } from "@/components/probes/CrankProbePanel";
import { OracleProbePanel } from "@/components/probes/OracleProbePanel";
import { SessionProbePanel } from "@/components/probes/SessionProbePanel";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0" aria-hidden>
      <defs>
        <linearGradient id="mc-mark" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.55" stopColor="#a9adb4" />
          <stop offset="1" stopColor="#54585f" />
        </linearGradient>
      </defs>
      <path d="M16 3a13 13 0 0 1 11.26 6.5" stroke="url(#mc-mark)" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M29 16a13 13 0 0 1 -6.5 11.26" stroke="url(#mc-mark)" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M16 29a13 13 0 0 1 -11.26 -6.5" stroke="url(#mc-mark)" strokeWidth="4" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="16" r="3" fill="url(#mc-mark)" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-col gap-6 border-b border-white/8 pb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <BrandMark />
              <div>
                <h1 className="text-[15px] font-semibold tracking-tight text-white">Mission Control</h1>
                <p className="text-[11.5px] text-white/40">MagicBlock Ephemeral Rollup ops console</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <StatusStrip />
              <WalletMultiButton />
            </div>
          </div>

          <div className="max-w-2xl">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
              Live on Solana devnet
            </p>
            <h2 className="mt-2 text-2xl font-medium tracking-tight text-white sm:text-3xl">
              Every MagicBlock primitive, running for real.
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-white/45">
              Six probes exercise the Ephemeral Rollup core, VRF, Magic Actions, Cranks, the Pricing
              Oracle, and Session Keys - each one sends real signed transactions, nothing here is
              simulated. Connect a devnet wallet below to drive them.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CoreProbePanel />
            <VrfProbePanel />
            <ActionsProbePanel />
            <CrankProbePanel />
            <OracleProbePanel />
            <SessionProbePanel />
          </div>
          <EventTimeline />
        </div>

        <footer className="pb-4 text-center text-[11px] text-white/25">
          Built for Solana Blitz V8 · every panel above sends real transactions to Solana devnet and
          MagicBlock&apos;s regional Ephemeral Rollup validators - nothing here is simulated.
        </footer>
      </div>
    </div>
  );
}
