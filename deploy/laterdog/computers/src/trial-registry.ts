import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import { newTrialId } from "./ids";
import { MINUTE } from "./idle";
import { type TrialRecord, trialListing } from "./trial";

const RETRY_MS = 60 * MINUTE;

export type Activation = { ok: true; trial: TrialRecord; replayed: boolean } | { ok: false; refusal: Refusal };

type Row = {
  id: string;
  key_sha256: string;
  created_at: number;
  expires_at: number;
  limit_ms: number;
  used_ms: number;
};

function trialOf(row: Row): TrialRecord {
  return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, limitMs: row.limit_ms, usedMs: row.used_ms };
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function trials(env: Env): DurableObjectStub<TrialRegistry> {
  return env.TRIALS.get(env.TRIALS.idFromName("trials"));
}

export class TrialRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS trials (
      id TEXT PRIMARY KEY,
      key_sha256 TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      limit_ms INTEGER NOT NULL,
      used_ms INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS networks (network TEXT PRIMARY KEY, until INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, started INTEGER NOT NULL)");
  }

  async activate(input: { keySha256: string; network: string; limitMs: number; windowMs: number; perDay: number }): Promise<Activation> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const prior = sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", input.keySha256).toArray()[0];
    if (prior && prior.expires_at > now) return { ok: true, trial: trialOf(prior), replayed: true };
    if (prior) return { ok: false, refusal: { status: 409, code: "trial_ended", message: "This free trial has ended." } };
    sql.exec("DELETE FROM networks WHERE until <= ?", now);
    if (sql.exec("SELECT 1 FROM networks WHERE network = ?", input.network).toArray().length > 0) {
      return {
        ok: false,
        refusal: { status: 429, code: "trial_network_used", message: "A free trial was already started from this network recently. Try again in a few days." },
      };
    }
    const day = new Date(now).toISOString().slice(0, 10);
    sql.exec("DELETE FROM days WHERE day <> ?", day);
    const started = sql.exec<{ started: number }>("SELECT started FROM days WHERE day = ?", day).toArray()[0]?.started ?? 0;
    if (started >= input.perDay) {
      return { ok: false, refusal: { status: 429, code: "trials_busy", message: "Today's free trials are all taken. Try again tomorrow." } };
    }
    let id = newTrialId();
    while (sql.exec("SELECT 1 FROM trials WHERE id = ?", id).toArray().length > 0) id = newTrialId();
    const expiresAt = now + input.windowMs;
    sql.exec(
      "INSERT INTO trials (id, key_sha256, created_at, expires_at, limit_ms, used_ms) VALUES (?, ?, ?, ?, ?, 0)",
      id,
      input.keySha256,
      now,
      expiresAt,
      input.limitMs,
    );
    sql.exec("INSERT INTO networks (network, until) VALUES (?, ?)", input.network, now + input.windowMs);
    sql.exec("INSERT INTO days (day, started) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET started = started + 1", day);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    console.log(`laterdog computers: trial ${id} started`);
    return { ok: true, trial: { id, createdAt: now, expiresAt, limitMs: input.limitMs, usedMs: 0 }, replayed: false };
  }

  find(keySha256: string): TrialRecord | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ? AND expires_at > ?", keySha256, Date.now()).toArray()[0];
    return row ? trialOf(row) : null;
  }

  lookup(id: string): TrialRecord | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM trials WHERE id = ? AND expires_at > ?", id, Date.now()).toArray()[0];
    return row ? trialOf(row) : null;
  }

  budgetLeft(id: string): number | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM trials WHERE id = ? AND expires_at > ?", id, Date.now()).toArray()[0];
    return row ? Math.max(0, row.limit_ms - row.used_ms) : null;
  }

  charge(id: string, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.ctx.storage.sql.exec("UPDATE trials SET used_ms = MIN(limit_ms, used_ms + ?) WHERE id = ?", Math.round(ms), id);
  }

  async end(id: string): Promise<void> {
    const listing = this.env.REGISTRY.get(this.env.REGISTRY.idFromName(trialListing(id)));
    for (const computer of await listing.list()) {
      const removed = await this.env.COMPUTER.get(this.env.COMPUTER.idFromName(computer.id)).remove();
      if (!removed.ok && removed.refusal.status !== 404) throw new Error(`${computer.id}: ${removed.refusal.message}`);
      await listing.remove(computer.id);
    }
    this.ctx.storage.sql.exec("DELETE FROM trials WHERE id = ?", id);
    console.log(`laterdog computers: trial ${id} ended`);
  }

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    let failed = false;
    for (const { id } of sql.exec<{ id: string }>("SELECT id FROM trials WHERE expires_at <= ? ORDER BY expires_at", now).toArray()) {
      try {
        await this.end(id);
      } catch (error) {
        failed = true;
        console.error(`laterdog computers: ending trial ${id} failed: ${describeError(error)}`);
      }
    }
    sql.exec("DELETE FROM networks WHERE until <= ?", now);
    const next = sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM trials WHERE expires_at > ?", now).one().at;
    const at = Math.min(next ?? Number.POSITIVE_INFINITY, failed ? now + RETRY_MS : Number.POSITIVE_INFINITY);
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at);
  }
}
