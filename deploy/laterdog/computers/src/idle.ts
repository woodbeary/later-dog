
export const MINUTE = 60_000;
export const RECHECK_BUSY_MS = MINUTE;
export const HEALTH_CHECK_MS = 5 * MINUTE;

export interface IdlePolicy {
  idleSleepMs: number;
  maxAwakeMs: number;
}

export interface IdleInput extends IdlePolicy {
  now: number;
  lastActiveAt: number;
  awakeSince: number;
  viewers: number;
  inFlight: number;
  budgetEndsAt?: number;
}

export type IdleDecision = { sleep: true; reason: "idle" | "max_awake" | "budget" } | { sleep: false; checkAt: number };

export function decideIdle(input: IdleInput): IdleDecision {
  const maxAwakeAt = input.awakeSince + input.maxAwakeMs;
  if (input.now >= maxAwakeAt) return { sleep: true, reason: "max_awake" };
  const budgetEndsAt = input.budgetEndsAt ?? Number.POSITIVE_INFINITY;
  if (input.now >= budgetEndsAt) return { sleep: true, reason: "budget" };
  const soon = (at: number) => ({ sleep: false as const, checkAt: Math.min(at, maxAwakeAt, budgetEndsAt, input.now + HEALTH_CHECK_MS) });
  if (input.viewers > 0 || input.inFlight > 0) return soon(input.now + RECHECK_BUSY_MS);
  const idleAt = input.lastActiveAt + input.idleSleepMs;
  if (input.now >= idleAt) return { sleep: true, reason: "idle" };
  return soon(idleAt);
}

export function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function idlePolicy(env: { IDLE_SLEEP_MINUTES?: string; MAX_AWAKE_HOURS?: string }): IdlePolicy {
  return {
    idleSleepMs: bounded(env.IDLE_SLEEP_MINUTES, 15, 1, 240) * MINUTE,
    maxAwakeMs: bounded(env.MAX_AWAKE_HOURS, 8, 0.25, 72) * 60 * MINUTE,
  };
}

export function inactivityTimeoutMs(policy: IdlePolicy): number {
  return Math.min(6 * 60 * MINUTE, policy.idleSleepMs + 45 * MINUTE);
}
