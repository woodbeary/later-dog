import type { WirePlan } from "../../shared/dog-plan";

export const PLAN_STALE_MS = 10 * 60_000;

export function planOutOfDate(
  plan: Pick<WirePlan, "items" | "updatedAt"> | null | undefined,
  turnStartedAt: number | null | undefined,
  now: number,
  limit = PLAN_STALE_MS,
): boolean {
  if (!plan || !Number.isFinite(plan.updatedAt) || typeof turnStartedAt !== "number") return false;
  if (!plan.items.some((item) => item.status !== "done")) return false;
  return now - plan.updatedAt >= limit;
}
