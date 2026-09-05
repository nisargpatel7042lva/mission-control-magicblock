"use client";

import { useEventLog, type EventLevel } from "@/lib/event-log";
import { Badge } from "./ui";

const levelTone: Record<EventLevel, "zinc" | "emerald" | "amber" | "rose" | "sky"> = {
  info: "sky",
  success: "emerald",
  error: "rose",
  pending: "amber",
};

function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

export function EventTimeline() {
  const { events, clear } = useEventLog();

  return (
    <section className="flex h-full flex-col gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold tracking-tight text-white">Mission Log</h2>
        <button
          onClick={clear}
          className="text-[10px] font-medium uppercase tracking-wide text-white/30 hover:text-white/70"
        >
          clear
        </button>
      </header>
      <div className="flex max-h-[520px] flex-col gap-1.5 overflow-y-auto pr-1">
        {events.length === 0 && (
          <p className="text-[12.5px] text-white/30">
            No activity yet - connect a wallet and run a probe below.
          </p>
        )}
        {events.map((e) => (
          <div
            key={e.id}
            className="flex items-start justify-between gap-2 border-b border-white/6 pb-1.5 text-[12.5px] last:border-0"
          >
            <div className="flex flex-1 items-start gap-2">
              <Badge tone={levelTone[e.level]}>{e.source}</Badge>
              <span className="text-white/70">{e.message}</span>
            </div>
            <div className="flex shrink-0 flex-col items-end text-[10px] text-white/30">
              <span>{timeAgo(e.at)}</span>
              {typeof e.durationMs === "number" && (
                <span className="font-mono text-white/40">{e.durationMs}ms</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
