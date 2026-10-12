import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import { newTrialId } from "./ids";
import { MINUTE } from "./idle";
import { type UsageKind, utcDay } from "./decide";
import { paidThrough, squareConfigured, subscription } from "./square";
import { type TrialRecord, trialListing } from "./trial";

const RETRY_MS = 60 * MINUTE;

export type PlanRow = {
  key_sha256: string;
  ref: string;
  link_id: string;
  order_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  status: "pending" | "active" | "canceled" | "ended";
  period_end: number | null;
  checked_at: number | null;
  created_at: number;
};

export function planPolicy(env: { PLAN_HOURS?: string; PLAN_GRACE_DAYS?: string }) {
  const hours = Number(env.PLAN_HOURS ?? "40");
  const grace = Number(env.PLAN_GRACE_DAYS ?? "3");
  return {
    limitMs: (Number.isFinite(hours) && hours > 0 ? hours : 40) * 60 * MINUTE,
    graceMs: (Number.isFinite(grace) && grace >= 0 ? grace : 3) * 24 * 60 * MINUTE,
  };
}

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
    // one row per trial a network started (networks above held one per network)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS network_trials (network TEXT NOT NULL, until INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS network_trials_network ON network_trials (network)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, started INTEGER NOT NULL)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plans (
      key_sha256 TEXT PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      link_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      customer_id TEXT,
      subscription_id TEXT,
      status TEXT NOT NULL,
      period_end INTEGER,
      checked_at INTEGER,
      created_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage (key_sha256 TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (key_sha256, day, kind))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage_totals (day TEXT NOT NULL, kind TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (day, kind))");
  }

  allowUsage(input: { keySha256: string; kind: UsageKind; amount: number; perKey: number; total: number }): { ok: true } | { ok: false; refusal: Refusal } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    if (sql.exec("SELECT 1 FROM trials WHERE key_sha256 = ? AND expires_at > ?", input.keySha256, now).toArray().length === 0) {
      return { ok: false, refusal: { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." } };
    }
    const amount = Math.max(1, Math.ceil(input.amount));
    const day = utcDay(now);
    sql.exec("DELETE FROM usage WHERE day <> ?", day);
    sql.exec("DELETE FROM usage_totals WHERE day <> ?", day);
    const mine = sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND day = ? AND kind = ?", input.keySha256, day, input.kind).toArray()[0]?.used ?? 0;
    if (mine + amount > input.perKey) return { ok: false, refusal: { status: 429, code: "daily_limit", message: "This installation has used today's allowance. It resets at midnight UTC." } };
    const all = sql.exec<{ used: number }>("SELECT used FROM usage_totals WHERE day = ? AND kind = ?", day, input.kind).toArray()[0]?.used ?? 0;
    if (all + amount > input.total) return { ok: false, refusal: { status: 503, code: "busy_today", message: "later.dog's included service is at today's limit. Try again tomorrow, or add your own key." } };
    sql.exec("INSERT INTO usage (key_sha256, day, kind, used) VALUES (?, ?, ?, ?) ON CONFLICT (key_sha256, day, kind) DO UPDATE SET used = used + ?", input.keySha256, day, input.kind, amount, amount);
    sql.exec("INSERT INTO usage_totals (day, kind, used) VALUES (?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET used = used + ?", day, input.kind, amount, amount);
    return { ok: true };
  }

  planPending(input: { keySha256: string; ref: string; linkId: string; orderId: string }): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO plans (key_sha256, ref, link_id, order_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (key_sha256) DO UPDATE SET ref = excluded.ref, link_id = excluded.link_id, order_id = excluded.order_id,
         status = CASE WHEN plans.status = 'active' THEN plans.status ELSE 'pending' END`,
      input.keySha256, input.ref, input.linkId, input.orderId, now,
    );
  }

  planByRef(ref: string): PlanRow | null {
    return this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM plans WHERE ref = ?", ref).toArray()[0] ?? null;
  }

  planFor(keySha256: string): PlanRow | null {
    return this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM plans WHERE key_sha256 = ?", keySha256).toArray()[0] ?? null;
  }

  async applyPlan(input: { keySha256: string; customerId: string; subscriptionId: string; status: "active" | "canceled"; periodEnd: number; limitMs: number; graceMs: number }): Promise<TrialRecord> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const plan = this.planFor(input.keySha256);
    const newPeriod = !plan?.period_end || input.periodEnd > plan.period_end;
    sql.exec(
      "UPDATE plans SET customer_id = ?, subscription_id = ?, status = ?, period_end = ?, checked_at = ? WHERE key_sha256 = ?",
      input.customerId, input.subscriptionId, input.status, input.periodEnd, now, input.keySha256,
    );
    const expiresAt = input.periodEnd + input.graceMs;
    const prior = sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", input.keySha256).toArray()[0];
    let trial: TrialRecord;
    if (prior) {
      const usedMs = newPeriod ? 0 : prior.used_ms;
      const until = Math.max(prior.expires_at, expiresAt);
      sql.exec("UPDATE trials SET expires_at = ?, limit_ms = ?, used_ms = ? WHERE id = ?", until, input.limitMs, usedMs, prior.id);
      trial = { id: prior.id, createdAt: prior.created_at, expiresAt: until, limitMs: input.limitMs, usedMs };
    } else {
      trial = this.insert(input.keySha256, now, input.limitMs, expiresAt - now);
    }
    await this.wakeBy(trial.expiresAt);
    console.log(`laterdog computers: plan ${input.status} for trial ${trial.id} until ${new Date(input.periodEnd).toISOString()}`);
    return trial;
  }

  markPlan(keySha256: string, status: "canceled" | "ended"): void {
    this.ctx.storage.sql.exec("UPDATE plans SET status = ?, checked_at = ? WHERE key_sha256 = ?", status, Date.now(), keySha256);
  }

  usageLeft(input: { keySha256: string; kind: UsageKind; perKey: number; total: number }): { ok: true } | { ok: false; refusal: Refusal } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    if (sql.exec("SELECT 1 FROM trials WHERE key_sha256 = ? AND expires_at > ?", input.keySha256, now).toArray().length === 0) {
      return { ok: false, refusal: { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." } };
    }
    const day = utcDay(now);
    const mine = sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND day = ? AND kind = ?", input.keySha256, day, input.kind).toArray()[0]?.used ?? 0;
    if (mine >= input.perKey) return { ok: false, refusal: { status: 429, code: "daily_limit", message: "This installation has used today's allowance. It resets at midnight UTC." } };
    const all = sql.exec<{ used: number }>("SELECT used FROM usage_totals WHERE day = ? AND kind = ?", day, input.kind).toArray()[0]?.used ?? 0;
    if (all >= input.total) return { ok: false, refusal: { status: 503, code: "busy_today", message: "later.dog's included service is at today's limit. Try again tomorrow, or add your own key." } };
    return { ok: true };
  }

  chargeUsage(input: { keySha256: string; kind: UsageKind; amount: number }): void {
    const amount = Math.ceil(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const sql = this.ctx.storage.sql;
    const day = utcDay(Date.now());
    sql.exec("DELETE FROM usage WHERE day <> ?", day);
    sql.exec("DELETE FROM usage_totals WHERE day <> ?", day);
    sql.exec("INSERT INTO usage (key_sha256, day, kind, used) VALUES (?, ?, ?, ?) ON CONFLICT (key_sha256, day, kind) DO UPDATE SET used = used + ?", input.keySha256, day, input.kind, amount, amount);
    sql.exec("INSERT INTO usage_totals (day, kind, used) VALUES (?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET used = used + ?", day, input.kind, amount, amount);
  }

  async activate(input: { keySha256: string; network: string; limitMs: number; windowMs: number; perDay: number; perNetwork?: number }): Promise<Activation> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const prior = sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", input.keySha256).toArray()[0];
    if (prior && prior.expires_at > now) return { ok: true, trial: trialOf(prior), replayed: true };
    if (prior) return { ok: false, refusal: { status: 409, code: "trial_ended", message: "This free trial has ended." } };
    sql.exec("DELETE FROM networks WHERE until <= ?", now);
    sql.exec("DELETE FROM network_trials WHERE until <= ?", now);
    const fromNetwork = sql.exec("SELECT 1 FROM networks WHERE network = ?", input.network).toArray().length
      + sql.exec("SELECT 1 FROM network_trials WHERE network = ?", input.network).toArray().length;
    if (fromNetwork >= Math.max(1, input.perNetwork ?? 1)) {
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
    const trial = this.insert(input.keySha256, now, input.limitMs, input.windowMs);
    sql.exec("INSERT INTO network_trials (network, until) VALUES (?, ?)", input.network, now + input.windowMs);
    sql.exec("INSERT INTO days (day, started) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET started = started + 1", day);
    await this.wakeBy(trial.expiresAt);
    console.log(`laterdog computers: trial ${trial.id} started`);
    return { ok: true, trial, replayed: false };
  }

  async grant(input: { keySha256: string; limitMs: number; windowMs: number }): Promise<Activation> {
    const now = Date.now();
    const prior = this.ctx.storage.sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", input.keySha256).toArray()[0];
    if (prior && prior.expires_at > now) return { ok: true, trial: trialOf(prior), replayed: true };
    if (prior) return { ok: false, refusal: { status: 409, code: "trial_ended", message: "This free trial has ended." } };
    const trial = this.insert(input.keySha256, now, input.limitMs, input.windowMs);
    await this.wakeBy(trial.expiresAt);
    console.log(`laterdog computers: trial ${trial.id} granted`);
    return { ok: true, trial, replayed: false };
  }

  private insert(keySha256: string, now: number, limitMs: number, windowMs: number): TrialRecord {
    const sql = this.ctx.storage.sql;
    let id = newTrialId();
    while (sql.exec("SELECT 1 FROM trials WHERE id = ?", id).toArray().length > 0) id = newTrialId();
    const expiresAt = now + windowMs;
    sql.exec("INSERT INTO trials (id, key_sha256, created_at, expires_at, limit_ms, used_ms) VALUES (?, ?, ?, ?, ?, 0)", id, keySha256, now, expiresAt, limitMs);
    return { id, createdAt: now, expiresAt, limitMs, usedMs: 0 };
  }

  private async wakeBy(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
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

  private async renewedPlan(keySha256: string): Promise<boolean> {
    const plan = this.planFor(keySha256);
    if (!plan?.subscription_id || !plan.customer_id || plan.status === "ended" || !squareConfigured(this.env)) return false;
    const current = await subscription(this.env, plan.subscription_id);
    const until = current ? paidThrough(current, Date.now()) : null;
    if (!current || until === null || until <= Date.now()) {
      this.markPlan(keySha256, "ended");
      return false;
    }
    await this.applyPlan({
      keySha256, customerId: plan.customer_id, subscriptionId: plan.subscription_id,
      status: current.status === "CANCELED" ? "canceled" : "active", periodEnd: until,
      limitMs: planPolicy(this.env).limitMs, graceMs: planPolicy(this.env).graceMs,
    });
    return true;
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
    for (const { id, key_sha256 } of sql.exec<{ id: string; key_sha256: string }>("SELECT id, key_sha256 FROM trials WHERE expires_at <= ? ORDER BY expires_at", now).toArray()) {
      try {
        if (await this.renewedPlan(key_sha256)) continue;
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
