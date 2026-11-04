import type { TaskUsage } from "@/state/store";
import { t } from "./i18n";
import { formatTokens } from "./usage";

export type ChatContextLevel = "ok" | "near" | "over";

export interface ChatContextReading {
  tokens: number;
  window: number | null;
  percent: number | null;
  level: ChatContextLevel;
}

export const CONTEXT_NEAR_PERCENT = 75;

const positive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function chatContextReading(context: TaskUsage["context"], modelWindow?: number): ChatContextReading | null {
  const tokens = positive(context?.tokens) ? Math.round(context.tokens) : 0;
  if (tokens <= 0) return null;
  const window = [context?.window, modelWindow].find(positive) ?? null;
  if (window === null) return { tokens, window: null, percent: null, level: "ok" };
  const share = (tokens / window) * 100;
  const percent = Math.min(100, Math.max(0, share));
  return { tokens, window, percent, level: percent >= 100 ? "over" : percent >= CONTEXT_NEAR_PERCENT ? "near" : "ok" };
}

export function contextPercentWords(percent: number): string {
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

export function chatContextFigure(reading: ChatContextReading): string {
  if (reading.window === null || reading.percent === null) return t("model.context.tokens", { used: formatTokens(reading.tokens) });
  return t("model.context.figure", {
    used: formatTokens(reading.tokens),
    window: formatTokens(reading.window),
    percent: contextPercentWords(reading.percent),
  });
}
