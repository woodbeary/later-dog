import { nextMidnightIn, resetInstant, type UsageLimit } from "../../laterdog/usage-limit.ts";

export interface GoogleLimitError {
  message?: unknown;
  code?: unknown;
  data?: unknown;
}

export type GoogleLimitFlavor = "gemini" | "antigravity";

export const GOOGLE_QUOTA_ZONE = "America/Los_Angeles";
export const THROTTLE_MAX_SECONDS = 300;
export const UNREPORTED_GEMINI_REST_MS = 15 * 60_000;
const SESSION_MAX_MS = 6 * 60 * 60_000;

const EXHAUSTED = /\bRESOURCE_EXHAUSTED\b|\bquota\b.{0,40}\b(?:reached|exceeded|exhausted)\b|\bexhausted your (?:daily )?quota\b|resource has been exhausted|\bspend(?:ing)? cap\b|\brate limit exceeded\b/i;
const CAPACITY = /exhausted your capacity|capacity exceeded|MODEL_CAPACITY_(?:EXHAUSTED|EXCEEDED)/i;
const PER_MINUTE = /PerMinute|\bper minute\b|requests per minute/i;
const PER_DAY = /PerDay|\bdaily\b|\bper day\b|requests per day/i;
const SPENDING_CAP = /\bspend(?:ing)? cap\b/i;
const RESETS_IN = /\bresets? in\s+((?:\d+\s*(?:d|h|m|s)\s*)+)/i;
const RETRY_AFTER = /(?:please retry in|suggested retry after|retry after)\s+([0-9.]+)\s*(ms|s)\b/i;
const RETRY_DELAY_FIELD = /"retryDelay"\s*:\s*"([0-9.]+)(ms|s)"/i;

function textOf(error: GoogleLimitError): string {
  const message = typeof error.message === "string" ? error.message : "";
  let data = "";
  if (typeof error.data === "string") data = error.data;
  else if (error.data !== undefined) {
    try { data = JSON.stringify(error.data) ?? ""; } catch { data = ""; }
  }
  return `${message}\n${data.slice(0, 4000)}`;
}

function durationMs(words: string): number {
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;
  let ms = 0;
  for (const [, count, unit] of words.matchAll(/(\d+)\s*(d|h|m|s)/gi)) {
    ms += Number(count) * unitMs[unit!.toLowerCase() as keyof typeof unitMs];
  }
  return ms;
}

function retrySeconds(text: string): number | undefined {
  const found = RETRY_AFTER.exec(text) ?? RETRY_DELAY_FIELD.exec(text);
  if (!found) return undefined;
  const value = Number(found[1]);
  if (!Number.isFinite(value)) return undefined;
  return found[2]!.toLowerCase() === "ms" ? value / 1000 : value;
}

const windowKind = (ms: number): string => ms <= SESSION_MAX_MS ? "session" : "weekly";

export function googleUsageLimit(error: GoogleLimitError, flavor: GoogleLimitFlavor, now: number = Date.now()): UsageLimit | null {
  const limit = classify(error, flavor, now);
  return limit && limit.kind !== "monthly" ? { ...limit, scope: "model" } : limit;
}

function classify(error: GoogleLimitError, flavor: GoogleLimitFlavor, now: number): UsageLimit | null {
  const text = textOf(error);
  const status429 = error.code === 429 || /\b429\b/.test(text);
  if (!status429 && !EXHAUSTED.test(text)) return null;
  if (CAPACITY.test(text)) return null;

  const resetsIn = RESETS_IN.exec(text)?.[1];
  const resetMs = resetsIn ? durationMs(resetsIn) : 0;
  if (resetMs > 0) {
    const resetsAt = resetInstant(now + resetMs, now);
    return { ...(resetsAt ? { resetsAt } : {}), kind: windowKind(resetMs) };
  }

  const daily = PER_DAY.test(text);
  if (PER_MINUTE.test(text) && !daily) return null;
  const seconds = retrySeconds(text);
  if (seconds !== undefined && seconds <= THROTTLE_MAX_SECONDS && !daily) return null;
  if (seconds !== undefined && seconds > THROTTLE_MAX_SECONDS) {
    const resetsAt = resetInstant(now + seconds * 1000, now);
    return resetsAt ? { resetsAt } : {};
  }

  if (SPENDING_CAP.test(text)) return { kind: "monthly" };
  if (daily) {
    const resetsAt = nextMidnightIn(GOOGLE_QUOTA_ZONE, now);
    return { ...(resetsAt ? { resetsAt } : {}), kind: "daily" };
  }
  return flavor === "antigravity" ? {} : { resetsAt: new Date(now + UNREPORTED_GEMINI_REST_MS).toISOString() };
}
