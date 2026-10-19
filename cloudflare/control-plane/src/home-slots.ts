const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_UNUSED_HOME_DAYS = 7;
const MAX_UNUSED_HOME_DAYS = 365;
const RELEASE_BATCH = 100;

export function unusedHomeDays(env: Env): number {
  const raw = (env as unknown as { CLOUD_HOME_UNUSED_DAYS?: unknown }).CLOUD_HOME_UNUSED_DAYS;
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!/^[0-9]{1,3}$/.test(text)) return DEFAULT_UNUSED_HOME_DAYS;
  const days = Number(text);
  return days <= MAX_UNUSED_HOME_DAYS ? days : DEFAULT_UNUSED_HOME_DAYS;
}

export async function markHomeUsed(env: Env, accountId: string, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE cloud_homes SET used_at = ? WHERE account_id = ? AND used_at IS NULL AND released_at IS NULL",
  ).bind(now, accountId).run();
  return result.meta.changes === 1;
}

export async function releaseUnusedHomes(env: Env, now = Date.now()): Promise<number> {
  const days = unusedHomeDays(env);
  if (days === 0) return 0;
  const result = await env.DB.prepare(
    `UPDATE cloud_homes SET released_at = ? WHERE account_id IN (
       SELECT account_id FROM cloud_homes
        WHERE used_at IS NULL AND released_at IS NULL AND created_at < ?
        ORDER BY created_at LIMIT ?
     )`,
  ).bind(now, now - days * DAY_MS, RELEASE_BATCH).run();
  return result.meta.changes;
}
