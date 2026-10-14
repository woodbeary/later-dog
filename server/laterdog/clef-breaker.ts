import type { DeciderFailure } from "../decider/types.ts";

export const BREAKER_FAILURES = 3;
export const BREAKER_COOL_MS = 60_000;

const COUNTED: ReadonlySet<DeciderFailure | string> = new Set<DeciderFailure>([
  "timeout", "unreachable", "rate_limited", "overloaded", "http_error", "malformed",
]);

export interface BreakerOptions {
  failures?: number;
  coolMs?: number;
  now?: () => number;
}

export function createBreaker(options: BreakerOptions = {}) {
  const limit = options.failures ?? BREAKER_FAILURES;
  const cool = options.coolMs ?? BREAKER_COOL_MS;
  const now = options.now ?? Date.now;
  const rows = new Map<string, { failed: number; openUntil: number }>();

  return {
    allow(key: string): boolean {
      const row = rows.get(key);
      if (!row || row.openUntil === 0) return true;
      if (now() < row.openUntil) return false;
      rows.set(key, { failed: limit - 1, openUntil: 0 });
      return true;
    },
    report(key: string, outcome: { ok: true } | { ok: false; reason: string }): void {
      if (outcome.ok) {
        rows.delete(key);
        return;
      }
      if (!COUNTED.has(outcome.reason)) return;
      const failed = (rows.get(key)?.failed ?? 0) + 1;
      rows.set(key, { failed, openUntil: failed >= limit ? now() + cool : 0 });
    },
    isOpen(key: string): boolean {
      const row = rows.get(key);
      return Boolean(row && row.openUntil !== 0 && now() < row.openUntil);
    },
  };
}

export type Breaker = ReturnType<typeof createBreaker>;
