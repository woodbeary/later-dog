import type { Bot, TaskUsage } from "@/state/store";
import { t } from "./i18n";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    if (hasFiniteCost(u.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  if (items.some((u) => u && u.input > 0 && !cachedKnown(u))) delete out.cachedInput;
  return out;
}

export function botUsage(bot: Pick<Bot, "tasks">): TaskUsage {
  return sumUsage((bot.tasks ?? []).map((t) => t.usage));
}

export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function cachedInput(u: TaskUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

export function headlineTokens(u: TaskUsage): number {
  return cachedKnown(u) ? Math.max(0, u.input - cachedInput(u)) + u.output : u.input + u.output;
}

function cachedKnown(u: Pick<TaskUsage, "cachedInput">): boolean {
  return hasFiniteCost(u.cachedInput);
}

export function tokensColumnLabel(total: TaskUsage): string {
  return t(cachedKnown(total) ? "usage.colNewTokens" : "usage.colTokens");
}

export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return t("chat.usage.captionSubscription");
  if (billing === "metered") return t("chat.usage.captionMetered");
  return t("chat.usage.captionEngine");
}
