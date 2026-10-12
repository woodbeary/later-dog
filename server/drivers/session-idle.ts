
export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const MINIMUM_IDLE_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`LATERDOG_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.LATERDOG_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`LATERDOG_${driverPrefix}_SESSION_IDLE_MS`] ?? env.LATERDOG_SESSION_IDLE_MS,
    ) ?? DEFAULT_IDLE_MS;
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}
