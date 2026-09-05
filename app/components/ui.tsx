"use client";

// Mission Control - shared UI primitives.
//
// Design system: restrained dark surface (near-black, not flat), one silver/
// white type voice, and color used only for meaning (live/success/warning/
// error) rather than as decoration. A panel's `accent` differentiates probes
// with a small dot + hairline top rule, not a loud colored border - six
// panels in six saturated hues read as a debug console, not a product.
// `ActionButton`'s default tone ("cyan", used by every panel's first/primary
// action) renders as a solid white pill; every other tone renders as a
// quiet outline pill with a small tinted dot. Both keep their existing prop
// shapes so no probe panel needs to change to pick up the new look.

import type { ReactNode } from "react";

type Tone = "cyan" | "violet" | "amber" | "emerald" | "rose" | "sky";

const DOT: Record<Tone, string> = {
  cyan: "bg-sky-400",
  sky: "bg-sky-400",
  violet: "bg-indigo-400",
  amber: "bg-amber-400",
  emerald: "bg-emerald-400",
  rose: "bg-rose-400",
};

const RULE: Record<Tone, string> = {
  cyan: "from-sky-400/70",
  sky: "from-sky-400/70",
  violet: "from-indigo-400/70",
  amber: "from-amber-400/70",
  emerald: "from-emerald-400/70",
  rose: "from-rose-400/70",
};

export function Panel({
  title,
  subtitle,
  right,
  children,
  accent = "cyan",
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  accent?: Tone;
}) {
  return (
    <section className="group relative flex flex-col gap-4 rounded-2xl border border-white/8 bg-white/[0.025] p-5 backdrop-blur-sm transition-colors hover:border-white/14">
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r ${RULE[accent]} to-transparent`}
      />
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[accent]}`} />
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-[11.5px] leading-snug text-white/40">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="flex flex-1 flex-col gap-3.5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">{label}</span>
      <span className={`text-[15px] text-white/90 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</span>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{children}</div>;
}

export function Badge({
  tone = "zinc",
  children,
}: {
  tone?: "zinc" | "emerald" | "amber" | "rose" | "sky";
  children: ReactNode;
}) {
  const map: Record<string, string> = {
    zinc: "bg-white/6 text-white/50 border-white/10",
    emerald: "bg-emerald-400/10 text-emerald-300 border-emerald-400/20",
    amber: "bg-amber-400/10 text-amber-300 border-amber-400/20",
    rose: "bg-rose-400/10 text-rose-300 border-rose-400/20",
    sky: "bg-sky-400/10 text-sky-300 border-sky-400/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function ActionButton({
  onClick,
  disabled,
  busy,
  tone = "cyan",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: Tone;
  children: ReactNode;
}) {
  const isPrimary = tone === "cyan";
  const outlineDot: Record<Tone, string> = {
    cyan: "bg-white",
    sky: "bg-sky-400",
    violet: "bg-indigo-400",
    amber: "bg-amber-400",
    emerald: "bg-emerald-400",
    rose: "bg-rose-400",
  };
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed";
  const primary = "bg-white text-black hover:bg-white/85 disabled:bg-white/10 disabled:text-white/30";
  const secondary =
    "border border-white/12 bg-white/[0.03] text-white/80 hover:bg-white/8 hover:text-white disabled:border-white/6 disabled:text-white/25";

  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`${base} ${isPrimary ? primary : secondary}`}
    >
      {!isPrimary && (
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${outlineDot[tone]} opacity-70`} />
      )}
      {busy ? "Working…" : children}
    </button>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}
