import { statusFallback } from "@/lib/plain-client-error";
import { HOME_WAKE_WORDS, WAKE_LIMIT_MS, WAKE_TOO_LONG, fromSavedCopy, homeWake, retryAfterMs, wakeDelayMs, type HomeWake } from "../../shared/home-wake";

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  readonly wake?: HomeWake;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, body?: Record<string, unknown>, home?: { wake?: HomeWake | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (home?.wake) this.wake = home.wake;
    if (home?.retryAfterMs) this.retryAfterMs = home.retryAfterMs;
  }
}

export type ApiInit = RequestInit & { timeoutMs?: number; rideWake?: boolean };

const sleepUnlessAborted = (ms: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener?.("abort", stop, { once: true });
  });

export interface ApiAnswer<T> {
  body: T;
  savedCopy: boolean;
}

export async function api<T = any>(path: string, init?: ApiInit): Promise<T> {
  return (await apiAnswer<T>(path, init)).body;
}

export async function apiAnswer<T = any>(path: string, init?: ApiInit): Promise<ApiAnswer<T>> {
  const { timeoutMs, signal, rideWake, ...rest } = init ?? {};
  const bounded = timeoutMs === undefined
    ? signal
    : signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  for (;;) {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...rest,
      signal: bounded,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { body, savedCopy: fromSavedCopy(res.headers) };
    const wake = homeWake(res.status, res.headers);
    const waitMs = retryAfterMs(res.headers, body);
    if (wake && rideWake !== false && (rest.body == null || typeof rest.body === "string")) {
      const delay = wakeDelayMs(wake, waitMs);
      if (Date.now() - started + delay <= WAKE_LIMIT_MS) {
        await sleepUnlessAborted(delay, bounded);
        continue;
      }
      throw new ApiError(WAKE_TOO_LONG, res.status, body, { wake, retryAfterMs: waitMs });
    }
    const message = wake ? HOME_WAKE_WORDS[wake] : typeof body.error === "string" && body.error ? body.error : statusFallback(res.status);
    throw new ApiError(message, res.status, body, { wake, retryAfterMs: waitMs });
  }
}
