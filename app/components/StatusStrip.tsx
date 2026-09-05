"use client";

import { useEffect, useState } from "react";
import { fetchServiceStatus, type ServiceStatusSnapshot } from "@/lib/magicblock-status";
import { REGIONS } from "@/lib/regions";
import { Badge } from "./ui";

export function StatusStrip() {
  const [snapshots, setSnapshots] = useState<ServiceStatusSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const data = await fetchServiceStatus("devnet");
        if (alive) {
          setSnapshots(data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "status fetch failed");
      }
    }
    poll();
    const id = setInterval(poll, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3.5 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">
        MagicBlock devnet
      </span>
      {error && <Badge tone="rose">status feed unreachable</Badge>}
      {!error && !snapshots && <Badge tone="zinc">loading…</Badge>}
      {REGIONS.map((region) => {
        const regionSnaps = snapshots?.filter((s) => s.region === region.id) ?? [];
        const allUp = regionSnaps.length > 0 && regionSnaps.every((s) => s.live !== false);
        const anyDown = regionSnaps.some((s) => s.live === false);
        const tone = anyDown ? "rose" : allUp ? "emerald" : "zinc";
        return (
          <Badge key={region.id} tone={tone}>
            {region.label}
          </Badge>
        );
      })}
    </div>
  );
}
