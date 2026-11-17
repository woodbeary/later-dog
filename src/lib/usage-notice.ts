import type { PlanProvider, PlanWindow } from "@/components/PlanUsage";

export const USAGE_NOTICE_FROM = 75;
export const USAGE_NOTICE_HIGH = 90;
export const USAGE_NOTICE_DISMISSED_KEY = "laterdog-usage-notice-dismissed";

export type UsageNoticeWindow = "weekly" | "fiveHour";
export type UsageNoticeLevel = "most" | "almost";

export interface UsageNotice {
  key: string;
  window: UsageNoticeWindow;
  level: UsageNoticeLevel;
  resetsAt: string | null;
}

const used = (window: PlanWindow | undefined): number | null =>
  window?.available && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : null;

export function usageNoticeFor(provider: PlanProvider | undefined): UsageNotice | null {
  if (!provider?.ok) return null;
  const weekly = used(provider.weekly);
  const fiveHour = used(provider.fiveHour);
  const window: UsageNoticeWindow | null = weekly === null && fiveHour === null ? null
    : fiveHour !== null && (weekly === null || fiveHour > weekly) ? "fiveHour" : "weekly";
  if (!window) return null;
  const percent = (window === "weekly" ? weekly : fiveHour)!;
  if (percent < USAGE_NOTICE_FROM || percent >= 100) return null;
  const level: UsageNoticeLevel = percent >= USAGE_NOTICE_HIGH ? "almost" : "most";
  const resetsAt = (window === "weekly" ? provider.weekly : provider.fiveHour).resetsAt ?? null;
  return { key: `${provider.id}:${window}:${level}:${resetsAt ?? ""}`, window, level, resetsAt };
}

export function resetClock(resetsAt: string, locale?: string): string {
  const at = new Date(resetsAt);
  return new Intl.DateTimeFormat(locale, at.getMinutes() === 0 ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" }).format(at);
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function usageNoticeDismissed(key: string): boolean {
  return storage()?.getItem(USAGE_NOTICE_DISMISSED_KEY) === key;
}

export function dismissUsageNotice(key: string): void {
  try {
    storage()?.setItem(USAGE_NOTICE_DISMISSED_KEY, key);
  } catch {
    return;
  }
}
