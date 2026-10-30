import { useSyncExternalStore } from "react";
import { api } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { Grant, GrantSpend, IncludedUsage, OwnerReport, SpendProvider, SpendService, UsageAmounts, UsageKind } from "../../shared/included-usage";
import { activeLocale, t } from "./i18n";
import { formatTokens, formatUsd } from "./usage";

export interface IncludedUsageSnapshot {
  usage: IncludedUsage | null;
  loaded: boolean;
  error: string;
  fetchedAt: number;
}

const STALE_MS = 60_000;
const HISTORY_DAYS = 30;

let snapshot: IncludedUsageSnapshot = { usage: null, loaded: false, error: "", fetchedAt: 0 };
const listeners = new Set<() => void>();
let request: Promise<void> | null = null;

function setSnapshot(next: Partial<IncludedUsageSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

const failed = (cause: unknown) => cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError");

export function reloadIncludedUsage(): Promise<void> {
  if (request) return request;
  const current = api<{ usage?: IncludedUsage | null }>(`/api/included-usage?days=${HISTORY_DAYS}`)
    .then(
      (answer) => setSnapshot({ usage: answer?.usage ?? null, loaded: true, error: "", fetchedAt: Date.now() }),
      (cause: unknown) => setSnapshot({ loaded: true, error: failed(cause), fetchedAt: Date.now() }),
    )
    .finally(() => {
      if (request === current) request = null;
    });
  request = current;
  return current;
}

function listen(listener: () => void) {
  listeners.add(listener);
  if (Date.now() - snapshot.fetchedAt >= STALE_MS) void reloadIncludedUsage();
  return () => {
    listeners.delete(listener);
  };
}

const read = () => snapshot;

export function useIncludedUsage(): IncludedUsageSnapshot {
  return useSyncExternalStore(listen, read, read);
}

export async function fetchOwnerReport(days = HISTORY_DAYS): Promise<OwnerReport | null> {
  const answer = await api<{ report?: OwnerReport | null }>(`/api/owner-usage?days=${days}`);
  return answer?.report ?? null;
}

export async function saveGrants(grants: Grant[]): Promise<GrantSpend[]> {
  const answer = await api<{ grants: GrantSpend[] }>("/api/owner-usage/grants", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grants }),
  });
  return answer.grants;
}

export type IncludedServiceId = "dictation" | "voice" | "chat" | "typing" | "review";
export type AmountUnit = "duration" | "chars" | "tokens" | "suggestions" | "checks";

export interface IncludedServiceDef {
  id: IncludedServiceId;
  label: LocaleKey;
  counts: readonly UsageKind[];
  limits: readonly UsageKind[];
  unit: AmountUnit;
}

export const INCLUDED_SERVICE_DEFS: readonly IncludedServiceDef[] = [
  { id: "dictation", label: "usage.service.dictation", counts: ["transcribe_seconds"], limits: ["transcribe_seconds"], unit: "duration" },
  { id: "voice", label: "usage.service.voice", counts: ["voice_chars"], limits: ["voice_chars"], unit: "chars" },
  { id: "chat", label: "usage.service.chat", counts: ["ai_tokens", "grok_tokens"], limits: ["ai_tokens"], unit: "tokens" },
  { id: "typing", label: "usage.service.typing", counts: ["completions"], limits: ["completions"], unit: "suggestions" },
  { id: "review", label: "usage.service.review", counts: ["decisions", "tool_decisions", "screen_checks"], limits: ["decisions", "tool_decisions", "screen_checks"], unit: "checks" },
];

export const SPEND_SERVICE_INFO: Record<SpendService, { label: LocaleKey; unit: AmountUnit }> = {
  dictation: { label: "usage.service.dictation", unit: "duration" },
  voice: { label: "usage.service.voice", unit: "chars" },
  chat: { label: "usage.service.chat", unit: "tokens" },
  typing: { label: "usage.service.typing", unit: "suggestions" },
  decisions: { label: "usage.service.review", unit: "checks" },
};

export const PROVIDER_LABEL: Record<SpendProvider, LocaleKey> = {
  elevenlabs: "dashboard.provider.elevenlabs",
  cloudflare: "dashboard.provider.cloudflare",
  xai: "dashboard.provider.xai",
  anthropic: "dashboard.provider.anthropic",
};

export function serviceUsed(used: UsageAmounts, def: Pick<IncludedServiceDef, "counts">): number {
  return def.counts.reduce((total, kind) => total + (used[kind] ?? 0), 0);
}

export function serviceUsedPercent(used: UsageAmounts, limits: UsageAmounts | null, def: Pick<IncludedServiceDef, "limits">): number | null {
  if (!limits) return null;
  let percent: number | null = null;
  for (const kind of def.limits) {
    const limit = limits[kind];
    if (!limit || limit <= 0) continue;
    const share = ((used[kind] ?? 0) / limit) * 100;
    if (percent === null || share > percent) percent = share;
  }
  return percent;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return t("usage.duration.seconds", { seconds: whole });
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return t("planUsage.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t("planUsage.hours", { hours }) : t("planUsage.hoursMinutes", { hours, minutes: rest });
}

export const formatCount = (value: number): string => formatTokens(Math.round(value));

const UNIT_KEYS: Record<Exclude<AmountUnit, "duration">, { many: LocaleKey; one: LocaleKey }> = {
  chars: { many: "usage.unit.chars", one: "usage.unit.charsOne" },
  tokens: { many: "usage.unit.tokens", one: "usage.unit.tokensOne" },
  suggestions: { many: "usage.unit.suggestions", one: "usage.unit.suggestionsOne" },
  checks: { many: "usage.unit.checks", one: "usage.unit.checksOne" },
};

const SLOT = "\u0000";

export function amountParts(value: number, unit: AmountUnit): { before: string; count: string; after: string } {
  if (unit === "duration") return { before: "", count: formatDuration(value), after: "" };
  const count = formatCount(value);
  const keys = UNIT_KEYS[unit];
  const key = count === String(Math.round(value)) && new Intl.PluralRules(activeLocale()).select(Math.round(value)) === "one" ? keys.one : keys.many;
  const text = t(key, { count: SLOT });
  const at = text.indexOf(SLOT);
  return at < 0 ? { before: "", count, after: ` ${text}` } : { before: text.slice(0, at), count, after: text.slice(at + SLOT.length) };
}

export function formatAmount(value: number, unit: AmountUnit): string {
  const { before, count, after } = amountParts(value, unit);
  return `${before}${count}${after}`;
}

const trim = (value: number) => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ""));

export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd)) return "";
  if (usd > 0 && usd < 0.001) return "<$0.001";
  if (usd < 1) return formatUsd(usd);
  const digits = usd >= 1000 ? 0 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatGrant(usd: number): string {
  return Number.isInteger(usd) ? `$${usd.toLocaleString("en-US")}` : formatMoney(usd);
}

export function formatTickUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 1000) return `$${trim(usd / 1000)}k`;
  if (usd >= 1) return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(1)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${Number(usd.toPrecision(2))}`;
}

export const microsToUsd = (micros: number): number => micros / 1_000_000;

export type ScaleKind = "count" | "money" | "duration";

const DURATION_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function decadeStep(max: number, multipliers: readonly number[], floor: number): number {
  const target = max / 2;
  let decade = 10 ** Math.floor(Math.log10(Math.max(target, floor)));
  for (;;) {
    for (const multiplier of multipliers) {
      const step = multiplier * decade;
      if (step >= floor && step >= target) return step;
    }
    decade *= 10;
  }
}

export function niceTicks(max: number, kind: ScaleKind): number[] {
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  let step: number;
  if (kind === "duration") {
    step = DURATION_STEPS.find((candidate) => candidate * 2 >= top) ?? decadeStep(top / 3600, [1, 2, 5], 1) * 3600;
  } else if (kind === "money") {
    step = top === 0 ? 0.01 : Number(decadeStep(top, [1, 2, 5], 1e-6).toPrecision(6));
  } else {
    step = top === 0 ? 1 : decadeStep(top, [1, 2, 2.5, 5], 1);
    if (!Number.isInteger(step)) step = decadeStep(top, [1, 2, 5], 1);
  }
  return [0, step, step * 2];
}

export function formatTick(value: number, kind: ScaleKind): string {
  if (kind === "money") return formatTickUsd(Number(value.toPrecision(6)));
  if (kind === "duration") return formatDuration(value);
  return formatCount(value);
}

export function formatDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString(activeLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
}
