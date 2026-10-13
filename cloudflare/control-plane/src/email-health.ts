export const DAILY_LIMIT_BLOCK_MS = 60 * 60_000;
export const RATE_LIMIT_BLOCK_MS = 60_000;

const LIMITS: Record<string, number> = {
  E_DAILY_LIMIT_EXCEEDED: DAILY_LIMIT_BLOCK_MS,
  E_RATE_LIMIT_EXCEEDED: RATE_LIMIT_BLOCK_MS,
};

export function emailLimitCode(error: unknown): string | null {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return Object.keys(LIMITS).find((limit) => code === limit || message.includes(limit)) ?? null;
}

export async function noteEmailFailure(db: D1Database, error: unknown, now = Date.now()): Promise<string | null> {
  const limit = emailLimitCode(error);
  if (!limit) return null;
  await db.prepare(
    "INSERT INTO email_health (id, blocked_until, reason) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET blocked_until = MAX(blocked_until, excluded.blocked_until), reason = excluded.reason",
  ).bind(now + LIMITS[limit]!, limit).run();
  return limit;
}

export async function emailBlocked(db: D1Database, now = Date.now()): Promise<boolean> {
  const row = await db.prepare("SELECT blocked_until FROM email_health WHERE id = 1").first<{ blocked_until: number }>();
  return (row?.blocked_until ?? 0) > now;
}
