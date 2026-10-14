import { useEffect, useRef, useState } from "react";

import type { ActivityKind } from "./live-activity";
import { ROW_SHOW_DELAY_MS, rowElapsed, rowPhrase } from "./thinking-row";

export const PHRASE_HOLD_MS = 800;

export function presenceElapsed(elapsedMs: number): string {
  return rowElapsed(elapsedMs);
}

export function useArmedAfter(wanted: boolean, delayMs: number = ROW_SHOW_DELAY_MS): boolean {
  const [armed, setArmed] = useState(wanted);
  useEffect(() => {
    if (delayMs <= 0) return;
    if (!wanted) {
      setArmed(false);
      return;
    }
    const timer = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(timer);
  }, [wanted, delayMs]);
  return wanted && (delayMs <= 0 || armed);
}

export function useActivityPresence(kind: ActivityKind, spoken: string | null, since: number | null, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, since]);
  const elapsed = since === null ? 0 : Math.max(0, now - since);
  const kindStart = useRef<{ kind: ActivityKind; at: number } | null>(null);
  if (kindStart.current?.kind !== kind) kindStart.current = { kind, at: Date.now() };
  const next = rowPhrase(kind, spoken, now - kindStart.current.at);
  const [phrase, setPhrase] = useState(next);
  const changedAt = useRef(Date.now());
  useEffect(() => {
    if (next === phrase) return;
    const timer = setTimeout(() => { changedAt.current = Date.now(); setPhrase(next); }, Math.max(0, PHRASE_HOLD_MS - (Date.now() - changedAt.current)));
    return () => clearTimeout(timer);
  }, [next, phrase]);
  return { phrase, elapsed: presenceElapsed(elapsed), now };
}
