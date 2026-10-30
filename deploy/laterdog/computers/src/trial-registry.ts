import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import { newTrialId } from "./ids";
import { MINUTE } from "./idle";
import { type UsageKind, utcDay } from "./decide";
import type { Tier } from "./gateway";
import { ownerKeys } from "./owner";
import { paidThrough, squareConfigured, subscription } from "./square";
import { type TrialRecord, trialListing } from "./trial";
import { PROVIDERS, type Provider, type Service, type Spend, isSpend } from "./usage-cost";

const RETRY_MS = 60 * MINUTE;
const DAY_MS = 24 * 60 * MINUTE;
export const HISTORY_DAYS = 90;
export const OWNER_RENEW_DAYS = 30;
export const TOP_INSTALLS = 10;

export function historyDays(asked: number): number {
  return Number.isInteger(asked) && asked >= 1 ? Math.min(asked, HISTORY_DAYS) : 30;
}

export function dayList(now: number, days: number): string[] {
  return Array.from({ length: days }, (_, index) => utcDay(now - (days - 1 - index) * DAY_MS));
}

export type UsageDay = { day: string; used: Partial<Record<UsageKind, number>>; micros?: number };

export type InstallUsage = { owner: boolean; tier: Tier; today: string; days: UsageDay[] };

export type Grant = { provider: Provider; usd: number; since: string };

export type OwnerReport = {
  today: string;
  days: string[];
  usage: { day: string; kind: UsageKind; used: number }[];
  active: { day: string; installs: number }[];
  activeInstalls: number;
  spend: { day: string; service: Service; provider: Provider; units: number; micros: number }[];
  top: { label: string; tier: Tier | null; owner: boolean; micros: number; services: { service: Service; units: number; micros: number }[] }[];
  grants: (Grant & { spentMicros: number })[];
};

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

export type UsageHold = { ok: true; day: string; amount: number; tier: Tier };

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
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS homes (key_sha256 TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage_totals (day TEXT NOT NULL, kind TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (day, kind))");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS usage_day ON usage (day)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spend (
      key_sha256 TEXT NOT NULL,
      day TEXT NOT NULL,
      service TEXT NOT NULL,
      provider TEXT NOT NULL,
      units INTEGER NOT NULL,
      micros INTEGER NOT NULL,
      PRIMARY KEY (key_sha256, day, service, provider)
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS spend_day ON spend (day)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spend_totals (
      day TEXT NOT NULL,
      service TEXT NOT NULL,
      provider TEXT NOT NULL,
      units INTEGER NOT NULL,
      micros INTEGER NOT NULL,
      PRIMARY KEY (day, service, provider)
    )`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS grants (provider TEXT PRIMARY KEY, usd REAL NOT NULL, since TEXT NOT NULL)");
  }

  private prunedDay = "";

  private isOwner(keySha256: string): boolean {
    return ownerKeys(this.env).has(keySha256);
  }

  private prune(now: number): void {
    const day = utcDay(now);
    if (this.prunedDay === day) return;
    const sql = this.ctx.storage.sql;
    const cutoff = utcDay(now - (HISTORY_DAYS - 1) * DAY_MS);
    sql.exec("DELETE FROM usage WHERE day < ?", cutoff);
    sql.exec("DELETE FROM spend WHERE day < ?", cutoff);
    this.prunedDay = day;
  }

  private count(keySha256: string, day: string, kind: UsageKind, amount: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO usage (key_sha256, day, kind, used) VALUES (?, ?, ?, ?) ON CONFLICT (key_sha256, day, kind) DO UPDATE SET used = used + ?", keySha256, day, kind, amount, amount);
    sql.exec("INSERT INTO usage_totals (day, kind, used) VALUES (?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET used = used + ?", day, kind, amount, amount);
  }

  private addSpend(keySha256: string, day: string, spend: Spend): void {
    if (!isSpend(spend)) return;
    const units = Math.round(spend.units);
    const micros = Math.round(spend.micros);
    if (units === 0 && micros === 0) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO spend (key_sha256, day, service, provider, units, micros) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key_sha256, day, service, provider) DO UPDATE SET units = units + excluded.units, micros = micros + excluded.micros",
      keySha256, day, spend.service, spend.provider, units, micros,
    );
    sql.exec(
      "INSERT INTO spend_totals (day, service, provider, units, micros) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, service, provider) DO UPDATE SET units = units + excluded.units, micros = micros + excluded.micros",
      day, spend.service, spend.provider, units, micros,
    );
  }

  recordSpend(input: { keySha256: string; spend: Spend }): void {
    const now = Date.now();
    this.prune(now);
    this.addSpend(input.keySha256, utcDay(now), input.spend);
  }

  allowUsage(input: { keySha256: string; kind: UsageKind; amount: number; perKey: number; total: number; spend?: Spend }): { ok: true; tier: Tier } | { ok: false; refusal: Refusal } {
    const taken = this.take(input);
    return taken.ok ? { ok: true, tier: taken.tier } : taken;
  }

  reserveUsage(input: { keySha256: string; kind: UsageKind; amount: number; perKey: number; perFullKey: number; total: number }): UsageHold | { ok: false; refusal: Refusal } {
    const tier = this.tierOf(input.keySha256);
    return this.take({ keySha256: input.keySha256, kind: input.kind, amount: input.amount, perKey: tier === "trial" ? input.perKey : input.perFullKey, total: input.total, tier });
  }

  settleUsage(input: { keySha256: string; kind: UsageKind; day: string; reserved: number; used: number; spend?: Spend }): void {
    if (input.spend) this.addSpend(input.keySha256, input.day, input.spend);
    const used = Number.isFinite(input.used) && input.used > 0 ? Math.ceil(input.used) : 0;
    const delta = used - input.reserved;
    if (delta === 0) return;
    if (input.day !== utcDay(Date.now()) && delta > 0) {
      this.chargeUsage({ keySha256: input.keySha256, kind: input.kind, amount: delta });
      return;
    }
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE usage SET used = MAX(0, used + ?) WHERE key_sha256 = ? AND day = ? AND kind = ?", delta, input.keySha256, input.day, input.kind);
    sql.exec("UPDATE usage_totals SET used = MAX(0, used + ?) WHERE day = ? AND kind = ?", delta, input.day, input.kind);
  }

  private take(input: { keySha256: string; kind: UsageKind; amount: number; perKey: number; total: number; tier?: Tier; spend?: Spend }): UsageHold | { ok: false; refusal: Refusal } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const owner = this.isOwner(input.keySha256);
    if (!owner && sql.exec("SELECT 1 FROM trials WHERE key_sha256 = ? AND expires_at > ?", input.keySha256, now).toArray().length === 0) {
      return { ok: false, refusal: { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." } };
    }
    const amount = Math.max(1, Math.ceil(input.amount));
    const day = utcDay(now);
    this.prune(now);
    if (!owner) {
      const mine = sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND day = ? AND kind = ?", input.keySha256, day, input.kind).toArray()[0]?.used ?? 0;
      if (mine + amount > input.perKey) return { ok: false, refusal: { status: 429, code: "daily_limit", message: "This installation has used today's allowance. It resets at midnight UTC." } };
      const all = sql.exec<{ used: number }>("SELECT used FROM usage_totals WHERE day = ? AND kind = ?", day, input.kind).toArray()[0]?.used ?? 0;
      if (all + amount > input.total) return { ok: false, refusal: { status: 503, code: "busy_today", message: "later.dog's included service is at today's limit. Try again tomorrow, or add your own key." } };
    }
    this.count(input.keySha256, day, input.kind, amount);
    if (input.spend) this.addSpend(input.keySha256, day, input.spend);
    return { ok: true, day, amount, tier: input.tier ?? this.tierOf(input.keySha256) };
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

  chargeUsage(input: { keySha256: string; kind: UsageKind; amount: number }): void {
    const amount = Math.ceil(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const now = Date.now();
    this.prune(now);
    this.count(input.keySha256, utcDay(now), input.kind, amount);
  }

  usageFor(keySha256: string, days: number): InstallUsage | null {
    const owner = this.isOwner(keySha256);
    if (!owner && !this.find(keySha256)) return null;
    const sql = this.ctx.storage.sql;
    const list = dayList(Date.now(), historyDays(days));
    const byDay = new Map<string, UsageDay>(list.map((day) => [day, { day, used: {}, ...(owner ? { micros: 0 } : {}) }]));
    for (const row of sql.exec<{ day: string; kind: UsageKind; used: number }>("SELECT day, kind, used FROM usage WHERE key_sha256 = ? AND day >= ?", keySha256, list[0]!)) {
      const entry = byDay.get(row.day);
      if (entry) entry.used[row.kind] = row.used;
    }
    if (owner) {
      for (const row of sql.exec<{ day: string; micros: number }>("SELECT day, SUM(micros) AS micros FROM spend WHERE key_sha256 = ? AND day >= ? GROUP BY day", keySha256, list[0]!)) {
        const entry = byDay.get(row.day);
        if (entry) entry.micros = row.micros;
      }
    }
    return { owner, tier: this.tierOf(keySha256), today: list[list.length - 1]!, days: [...byDay.values()] };
  }

  ownerReport(keySha256: string, days: number): OwnerReport | null {
    if (!this.isOwner(keySha256)) return null;
    const sql = this.ctx.storage.sql;
    const list = dayList(Date.now(), historyDays(days));
    const from = list[0]!;
    const owners = ownerKeys(this.env);
    const top = sql.exec<{ key_sha256: string; micros: number }>(
      "SELECT key_sha256, SUM(micros) AS micros FROM spend WHERE day >= ? GROUP BY key_sha256 ORDER BY micros DESC LIMIT ?", from, TOP_INSTALLS,
    ).toArray().map((row) => {
      const trial = sql.exec<{ id: string }>("SELECT id FROM trials WHERE key_sha256 = ?", row.key_sha256).toArray()[0];
      const live = this.find(row.key_sha256) !== null || owners.has(row.key_sha256);
      return {
        label: trial?.id ?? "ended",
        tier: live ? this.tierOf(row.key_sha256) : null,
        owner: owners.has(row.key_sha256),
        micros: row.micros,
        services: sql.exec<{ service: Service; units: number; micros: number }>(
          "SELECT service, SUM(units) AS units, SUM(micros) AS micros FROM spend WHERE key_sha256 = ? AND day >= ? GROUP BY service ORDER BY micros DESC", row.key_sha256, from,
        ).toArray(),
      };
    });
    return {
      today: list[list.length - 1]!,
      days: list,
      usage: sql.exec<{ day: string; kind: UsageKind; used: number }>("SELECT day, kind, used FROM usage_totals WHERE day >= ? ORDER BY day, kind", from).toArray(),
      active: sql.exec<{ day: string; installs: number }>("SELECT day, COUNT(DISTINCT key_sha256) AS installs FROM usage WHERE day >= ? GROUP BY day ORDER BY day", from).toArray(),
      activeInstalls: sql.exec<{ installs: number }>("SELECT COUNT(DISTINCT key_sha256) AS installs FROM usage WHERE day >= ?", from).one().installs,
      spend: sql.exec<{ day: string; service: Service; provider: Provider; units: number; micros: number }>(
        "SELECT day, service, provider, units, micros FROM spend_totals WHERE day >= ? ORDER BY day, provider, service", from,
      ).toArray(),
      top,
      grants: this.grants(),
    };
  }

  private grants(): (Grant & { spentMicros: number })[] {
    const sql = this.ctx.storage.sql;
    return sql.exec<Grant>("SELECT provider, usd, since FROM grants ORDER BY provider").toArray().map((grant) => ({
      provider: grant.provider,
      usd: grant.usd,
      since: grant.since,
      spentMicros: sql.exec<{ micros: number | null }>("SELECT SUM(micros) AS micros FROM spend_totals WHERE provider = ? AND day >= ?", grant.provider, grant.since).one().micros ?? 0,
    }));
  }

  setGrants(keySha256: string, grants: Grant[]): (Grant & { spentMicros: number })[] | null {
    if (!this.isOwner(keySha256)) return null;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM grants");
    for (const grant of grants) {
      if (!PROVIDERS.includes(grant.provider)) continue;
      sql.exec("INSERT INTO grants (provider, usd, since) VALUES (?, ?, ?) ON CONFLICT (provider) DO UPDATE SET usd = excluded.usd, since = excluded.since", grant.provider, grant.usd, grant.since);
    }
    return this.grants();
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

  async grantHome(input: { keySha256: string; limitMs: number; windowMs: number }): Promise<Activation> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("INSERT INTO homes (key_sha256) VALUES (?) ON CONFLICT (key_sha256) DO NOTHING", input.keySha256);
    const prior = sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", input.keySha256).toArray()[0];
    if (!prior) {
      const trial = this.insert(input.keySha256, now, input.limitMs, input.windowMs);
      await this.wakeBy(trial.expiresAt);
      console.log(`laterdog computers: home ${trial.id} granted`);
      return { ok: true, trial, replayed: false };
    }
    const until = Math.max(prior.expires_at, now + input.windowMs);
    const usedMs = until > prior.expires_at ? 0 : prior.used_ms;
    sql.exec("UPDATE trials SET expires_at = ?, limit_ms = ?, used_ms = ? WHERE id = ?", until, input.limitMs, usedMs, prior.id);
    console.log(`laterdog computers: home ${prior.id} renewed until ${new Date(until).toISOString()}`);
    return { ok: true, trial: { id: prior.id, createdAt: prior.created_at, expiresAt: until, limitMs: input.limitMs, usedMs }, replayed: true };
  }

  async holder(keySha256: string): Promise<{ trial: TrialRecord; fullAllowance: boolean; home: boolean } | null> {
    const trial = this.find(keySha256) ?? (this.isOwner(keySha256) ? await this.renewOwner(keySha256) : null);
    if (!trial) return null;
    const home = this.homeGrant(keySha256);
    return { trial, fullAllowance: home || this.isOwner(keySha256) || this.planPaid(keySha256), home };
  }

  tierFor(keySha256: string): Tier | null {
    return this.isOwner(keySha256) || this.find(keySha256) ? this.tierOf(keySha256) : null;
  }

  private async renewOwner(keySha256: string): Promise<TrialRecord> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const expiresAt = now + OWNER_RENEW_DAYS * DAY_MS;
    const prior = sql.exec<Row>("SELECT * FROM trials WHERE key_sha256 = ?", keySha256).toArray()[0];
    let trial: TrialRecord;
    if (prior) {
      sql.exec("UPDATE trials SET expires_at = ?, used_ms = 0 WHERE id = ?", expiresAt, prior.id);
      trial = { ...trialOf(prior), expiresAt, usedMs: 0 };
    } else {
      trial = this.insert(keySha256, now, planPolicy(this.env).limitMs, expiresAt - now);
    }
    await this.wakeBy(expiresAt);
    console.log(`laterdog computers: trial ${trial.id} renewed until ${new Date(expiresAt).toISOString()}`);
    return trial;
  }

  private renewed(id: string): boolean {
    const row = this.ctx.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM trials WHERE id = ?", id).toArray()[0];
    if (row && row.expires_at > Date.now()) {
      console.log(`laterdog computers: trial ${id} was renewed while it was ending, so it stays`);
      return true;
    }
    return false;
  }

  private tierOf(keySha256: string): Tier {
    if (this.isOwner(keySha256)) return "owner";
    if (this.planPaid(keySha256)) return "plan";
    return this.homeGrant(keySha256) ? "home" : "trial";
  }

  private homeGrant(keySha256: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM homes WHERE key_sha256 = ?", keySha256).toArray().length > 0;
  }

  private planPaid(keySha256: string): boolean {
    const plan = this.planFor(keySha256);
    if (!plan || (plan.status !== "active" && plan.status !== "canceled") || plan.period_end === null) return false;
    return Date.now() < plan.period_end + planPolicy(this.env).graceMs;
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

  async end(id: string, options: { expiredOnly?: boolean } = {}): Promise<void> {
    if (options.expiredOnly && this.renewed(id)) return;
    const listing = this.env.REGISTRY.get(this.env.REGISTRY.idFromName(trialListing(id)));
    for (const computer of await listing.list()) {
      const removed = await this.env.COMPUTER.get(this.env.COMPUTER.idFromName(computer.id)).remove();
      if (!removed.ok && removed.refusal.status !== 404) throw new Error(`${computer.id}: ${removed.refusal.message}`);
      await listing.remove(computer.id);
    }
    if (options.expiredOnly && this.renewed(id)) return;
    this.ctx.storage.sql.exec("DELETE FROM homes WHERE key_sha256 IN (SELECT key_sha256 FROM trials WHERE id = ?)", id);
    this.ctx.storage.sql.exec("DELETE FROM trials WHERE id = ?", id);
    console.log(`laterdog computers: trial ${id} ended`);
  }

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    let failed = false;
    for (const { id, key_sha256 } of sql.exec<{ id: string; key_sha256: string }>("SELECT id, key_sha256 FROM trials WHERE expires_at <= ? ORDER BY expires_at", now).toArray()) {
      try {
        if (this.isOwner(key_sha256)) {
          await this.renewOwner(key_sha256);
          continue;
        }
        if (await this.renewedPlan(key_sha256)) continue;
        await this.end(id, { expiredOnly: true });
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
