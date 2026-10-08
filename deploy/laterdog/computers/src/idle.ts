// When an awake computer should go to sleep. Pure, so the policy is unit tested apart from the Durable Object.
//
// - An open viewer or a request in flight keeps it awake (checked again every minute).
// - Otherwise it sleeps once IDLE_SLEEP_MINUTES have passed since its last activity.
// - Whatever happens, it sleeps once it has been awake MAX_AWAKE_HOURS (a forgotten viewer tab or a runaway loop).
// The next check is never more than five minutes away, which doubles as a health check of the container.

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
}

export type IdleDecision = { sleep: true; reason: "idle" | "max_awake" } | { sleep: false; checkAt: number };

export function decideIdle(input: IdleInput): IdleDecision {
  const maxAwakeAt = input.awakeSince + input.maxAwakeMs;
  if (input.now >= maxAwakeAt) return { sleep: true, reason: "max_awake" };
  const soon = (at: number) => ({ sleep: false as const, checkAt: Math.min(at, maxAwakeAt, input.now + HEALTH_CHECK_MS) });
  if (input.viewers > 0 || input.inFlight > 0) return soon(input.now + RECHECK_BUSY_MS);
  const idleAt = input.lastActiveAt + input.idleSleepMs;
  if (input.now >= idleAt) return { sleep: true, reason: "idle" };
  return soon(idleAt);
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function idlePolicy(env: { IDLE_SLEEP_MINUTES?: string; MAX_AWAKE_HOURS?: string }): IdlePolicy {
  return {
    // At most four hours, so the inactivity timeout below (idle + 45 minutes) stays under the platform's six-hour cap.
    idleSleepMs: bounded(env.IDLE_SLEEP_MINUTES, 15, 1, 240) * MINUTE,
    maxAwakeMs: bounded(env.MAX_AWAKE_HOURS, 8, 0.25, 72) * 60 * MINUTE,
  };
}

export function maxComputers(env: { MAX_COMPUTERS?: string }): number {
  return Math.floor(bounded(env.MAX_COMPUTERS, 10, 0, 1000));
}

/**
 * How long the platform keeps a container running once its Durable Object goes quiet. It must outlast the idle policy, so
 * the alarm snapshots the computer before the platform would stop it without one; the runtime caps it at six hours.
 */
export function inactivityTimeoutMs(policy: IdlePolicy): number {
  return Math.min(6 * 60 * MINUTE, policy.idleSleepMs + 45 * MINUTE);
}
