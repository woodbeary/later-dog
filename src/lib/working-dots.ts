import { useEffect, useState } from "react";

import type { Message } from "@/state/store";

export const STILL_WORKING_MS = 2_000;

export function workingTail(busy: boolean | undefined, last: Message | undefined, since?: number | null): "now" | "later" | "never" {
  if (!busy) return "never";
  if (last?.role !== "bot" || (since != null && last.at < since)) return "now";
  if (last.kind === "text") return last.turnTerminal ? "never" : "later";
  return since != null && (last.kind === "digest" || last.kind === "screen") ? "never" : "now";
}

export function useWorkingDots(busy: boolean | undefined, last: Message | undefined, since?: number | null): boolean {
  const tail = workingTail(busy, last, since);
  const held = tail === "later" ? last?.id : undefined;
  const [late, setLate] = useState<string>();
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setLate(held), STILL_WORKING_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return tail === "now" || (held !== undefined && late === held);
}
