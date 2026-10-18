export type HomeWake = "waking" | "busy" | "asleep";

export const WAKE_HEADER = "x-laterdog-home";
export const WAKE_LIMIT_MS = 120_000;
export const WAKE_DELAY_CAP_MS = 15_000;

const DEFAULT_SECONDS: Record<HomeWake, number> = { waking: 2, busy: 10, asleep: 15 };

export const HOME_WAKE_WORDS: Record<HomeWake, string> = {
  waking: "Your home is waking up. This takes a few seconds.",
  busy: "later.dog is busy right now. Trying again in a moment.",
  asleep: "Your home is resting. It wakes up when you send a message.",
};

export const WAKE_TOO_LONG = "Your home is taking longer than usual to wake up. Try again in a minute.";

export interface HeaderReader {
  get(name: string): string | null;
}

export function isHomeWake(value: unknown): value is HomeWake {
  return value === "waking" || value === "busy" || value === "asleep";
}

function header(headers: HeaderReader | null | undefined, name: string): string | null {
  try {
    return typeof headers?.get === "function" ? headers.get(name) : null;
  } catch {
    return null;
  }
}

export function homeWake(status: number, headers: HeaderReader | null | undefined): HomeWake | null {
  if (status !== 503) return null;
  const said = header(headers, WAKE_HEADER);
  return isHomeWake(said) ? said : null;
}

export function retryAfterMs(headers: HeaderReader | null | undefined, body?: { retryAfter?: unknown } | null): number | null {
  const fromBody = Number(body?.retryAfter);
  const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number(header(headers, "retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(WAKE_DELAY_CAP_MS, Math.max(1_000, seconds * 1_000)) : null;
}

export function wakeDelayMs(wake: HomeWake, retryAfter: number | null): number {
  return retryAfter ?? DEFAULT_SECONDS[wake] * 1_000;
}
