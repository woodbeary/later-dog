import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { contextBreakdownOf, type ContextBreakdown, type ContextPartId, type ContextSource } from "../../shared/context-breakdown";
import { ApiError } from "./api";
import { t } from "./i18n";
import { formatTokens } from "./usage";

export type ContextBreakdownView =
  | { state: "loading"; breakdown: ContextBreakdown | null }
  | { state: "ready"; breakdown: ContextBreakdown }
  | { state: "nothing" }
  | { state: "unavailable" };

const lastKnown = new Map<string, ContextBreakdown>();

export function rememberedBreakdown(threadId: string): ContextBreakdown | null {
  return lastKnown.get(threadId) ?? null;
}

export function forgetBreakdowns(): void {
  lastKnown.clear();
}

export async function fetchContextBreakdown(threadId: string): Promise<ContextBreakdownView> {
  try {
    const breakdown = contextBreakdownOf(await api<unknown>(`/api/threads/${encodeURIComponent(threadId)}/context`, { timeoutMs: 15_000, rideWake: false }));
    if (!breakdown) return { state: "unavailable" };
    lastKnown.set(threadId, breakdown);
    return { state: "ready", breakdown };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.body?.error === "nothing yet") return { state: "nothing" };
    return { state: "unavailable" };
  }
}

export function useContextBreakdown(threadId: string | undefined, open: boolean): ContextBreakdownView | null {
  const [view, setView] = useState<{ threadId: string; view: ContextBreakdownView } | null>(null);
  useEffect(() => {
    if (!threadId || !open) return;
    let active = true;
    setView({ threadId, view: { state: "loading", breakdown: rememberedBreakdown(threadId) } });
    void fetchContextBreakdown(threadId).then((fetched) => {
      if (!active) return;
      const kept = rememberedBreakdown(threadId);
      setView({ threadId, view: fetched.state === "unavailable" && kept ? { state: "ready", breakdown: kept } : fetched });
    });
    return () => {
      active = false;
    };
  }, [threadId, open]);
  return view && view.threadId === threadId ? view.view : null;
}

export function partLabel(id: ContextPartId, source: ContextSource): string {
  return source === "estimate" && id === "conversation" ? t("model.context.part.conversationEstimate") : t(`model.context.part.${id}`);
}

export function partShareWords(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

export function partTokensWords(tokens: number, estimate: boolean): string {
  const shown = formatTokens(tokens);
  return estimate ? t("model.context.about", { tokens: shown }) : shown;
}

export const STALE_AFTER_MS = 60_000;
