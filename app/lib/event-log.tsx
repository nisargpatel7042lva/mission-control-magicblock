"use client";

// Mission Control - shared operations timeline.
//
// Every probe panel logs into this single feed instead of keeping its own
// silent state, so the dashboard reads like a real ops console: a stream of
// what actually happened, across every MagicBlock primitive, in the order
// it happened - not six panels each quietly doing their own thing.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type EventLevel = "info" | "success" | "error" | "pending";

export interface MissionEvent {
  id: string;
  at: number;
  source: string; // e.g. "ER Core", "VRF", "Crank"
  level: EventLevel;
  message: string;
  durationMs?: number;
  signature?: string;
}

interface EventLogContextValue {
  events: MissionEvent[];
  log: (e: Omit<MissionEvent, "id" | "at">) => string;
  update: (id: string, patch: Partial<MissionEvent>) => void;
  clear: () => void;
}

const EventLogContext = createContext<EventLogContextValue | null>(null);

export function EventLogProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<MissionEvent[]>([]);

  const log = useCallback((e: Omit<MissionEvent, "id" | "at">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setEvents((prev) => [{ ...e, id, at: Date.now() }, ...prev].slice(0, 200));
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<MissionEvent>) => {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const clear = useCallback(() => setEvents([]), []);

  const value = useMemo(() => ({ events, log, update, clear }), [events, log, update, clear]);

  return <EventLogContext.Provider value={value}>{children}</EventLogContext.Provider>;
}

export function useEventLog() {
  const ctx = useContext(EventLogContext);
  if (!ctx) throw new Error("useEventLog must be used within EventLogProvider");
  return ctx;
}
