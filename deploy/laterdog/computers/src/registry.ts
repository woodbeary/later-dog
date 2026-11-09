
import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import type { ComputerView, State } from "./computer";
import { newComputerId } from "./ids";
import type { Size } from "./inputs";
import {
  type BuildReport,
  DEFAULT_SETUP_SCRIPT,
  type EnvironmentPlan,
  type EnvironmentRow,
  type EnvironmentView,
  type Outcome,
  decideEnvironment,
  environmentKey,
  environmentView,
  scriptHash,
} from "./environments";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type EnvironmentSqlRow = {
  key: string;
  repository: string;
  script_hash: string;
  image: string;
  snapshot: string | null;
  built_at: number | null;
  restored_at: number | null;
  setup_ms: number | null;
  building_since: number | null;
  outcome: string | null;
  attempt_at: number | null;
  error: string | null;
};

function fromSql(row: EnvironmentSqlRow): EnvironmentRow {
  return {
    key: row.key,
    repository: row.repository,
    scriptHash: row.script_hash,
    image: row.image,
    ...(row.snapshot === null ? {} : { snapshot: JSON.parse(row.snapshot) }),
    ...(row.built_at === null ? {} : { builtAt: row.built_at }),
    ...(row.restored_at === null ? {} : { restoredAt: row.restored_at }),
    ...(row.setup_ms === null ? {} : { setupMs: row.setup_ms }),
    ...(row.building_since === null ? {} : { buildingSince: row.building_since }),
    ...(row.outcome === null ? {} : { outcome: row.outcome as Outcome }),
    ...(row.attempt_at === null ? {} : { attemptAt: row.attempt_at }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

export type Reservation = { ok: true; id: string; name: string; size: Size; replayed: boolean } | { ok: false; refusal: Refusal };

type Row = {
  id: string;
  name: string;
  size: string;
  state: string;
  created_at: string;
  last_active_at: string;
  snapshot_at: string | null;
  error: string | null;
};

export class ComputerRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS computers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      snapshot_at TEXT,
      error TEXT
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      computer_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS environment_scripts (
      repository TEXT PRIMARY KEY,
      script TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS environments (
      key TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      script_hash TEXT NOT NULL,
      image TEXT NOT NULL,
      snapshot TEXT,
      built_at INTEGER,
      restored_at INTEGER,
      setup_ms INTEGER,
      building_since INTEGER,
      outcome TEXT,
      attempt_at INTEGER,
      error TEXT
    )`);
  }

  async environmentPlan(input: { repository: string; image: string }): Promise<EnvironmentPlan> {
    const now = Date.now();
    const custom = this.customScript(input.repository);
    const script = custom ?? DEFAULT_SETUP_SCRIPT;
    const key = await environmentKey(input.repository, script, input.image);
    const row = this.environmentRow(key);
    const decision = decideEnvironment(row, now);
    if (decision.build) {
      if (row) this.ctx.storage.sql.exec("UPDATE environments SET building_since = ? WHERE key = ?", now, key);
      else {
        this.ctx.storage.sql.exec(
          "INSERT INTO environments (key, repository, script_hash, image, building_since) VALUES (?, ?, ?, ?, ?)",
          key, input.repository, await scriptHash(script), input.image, now,
        );
      }
    }
    const after = this.environmentRow(key);
    return {
      key,
      repository: input.repository,
      image: input.image,
      decision,
      ...(decision.use && row?.snapshot ? { snapshot: row.snapshot } : {}),
      ...(decision.build ? { script } : {}),
      view: environmentView(after, { key, repository: input.repository, custom: custom !== undefined }, now),
    };
  }

  setEnvironmentScript(input: { repository: string; script: string | null }): void {
    if (input.script === null) this.ctx.storage.sql.exec("DELETE FROM environment_scripts WHERE repository = ?", input.repository);
    else {
      this.ctx.storage.sql.exec(
        "INSERT INTO environment_scripts (repository, script, updated_at) VALUES (?, ?, ?) ON CONFLICT(repository) DO UPDATE SET script = excluded.script, updated_at = excluded.updated_at",
        input.repository, input.script, Date.now(),
      );
    }
  }

  environmentBuilt(report: BuildReport): void {
    const sql = this.ctx.storage.sql;
    const row = this.environmentRow(report.key);
    if (!row) return;
    const now = Date.now();
    if (report.outcome === "ready" && report.snapshot) {
      sql.exec(
        "UPDATE environments SET snapshot = ?, built_at = ?, restored_at = NULL, setup_ms = ?, building_since = NULL, outcome = 'ready', attempt_at = ?, error = NULL WHERE key = ?",
        JSON.stringify(report.snapshot), now, report.setupMs, now, report.key,
      );
      sql.exec("DELETE FROM environments WHERE repository = ? AND key != ?", row.repository, report.key);
      return;
    }
    sql.exec(
      "UPDATE environments SET building_since = NULL, outcome = ?, attempt_at = ?, error = ?, setup_ms = ? WHERE key = ?",
      report.outcome === "ready" ? "failed" : report.outcome, now, report.error ?? null, report.setupMs, report.key,
    );
  }

  environmentRestored(key: string): void {
    this.ctx.storage.sql.exec("UPDATE environments SET restored_at = ? WHERE key = ? AND snapshot IS NOT NULL", Date.now(), key);
  }

  environments(): EnvironmentView[] {
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<EnvironmentSqlRow>("SELECT * FROM environments ORDER BY repository, key")
      .toArray()
      .map((sqlRow) => {
        const row = fromSql(sqlRow);
        return environmentView(row, { key: row.key, repository: row.repository, custom: this.customScript(row.repository) !== undefined }, now);
      });
  }

  private customScript(repository: string): string | undefined {
    return this.ctx.storage.sql.exec<{ script: string }>("SELECT script FROM environment_scripts WHERE repository = ?", repository).toArray()[0]?.script;
  }

  private environmentRow(key: string): EnvironmentRow | undefined {
    const found = this.ctx.storage.sql.exec<EnvironmentSqlRow>("SELECT * FROM environments WHERE key = ?", key).toArray()[0];
    return found ? fromSql(found) : undefined;
  }

  reserve(input: { name?: string; size: Size; idempotencyKey?: string; max?: number }): Reservation {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
    if (input.idempotencyKey !== undefined) {
      const prior = sql.exec<{ computer_id: string }>("SELECT computer_id FROM idempotency WHERE key = ?", input.idempotencyKey).toArray()[0];
      const row = prior && sql.exec<Row>("SELECT * FROM computers WHERE id = ?", prior.computer_id).toArray()[0];
      if (row) return { ok: true, id: row.id, name: row.name, size: row.size as Size, replayed: true };
      sql.exec("DELETE FROM idempotency WHERE key = ?", input.idempotencyKey);
    }
    const count = input.max === undefined ? 0 : sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM computers").one().n;
    if (input.max !== undefined && count >= input.max) {
      return { ok: false, refusal: { status: 409, code: "limit_reached", message: `This deployment allows ${input.max} computers at once; delete one first.` } };
    }
    let id = newComputerId();
    while (sql.exec("SELECT 1 FROM computers WHERE id = ?", id).toArray().length > 0) id = newComputerId();
    const name = input.name ?? id;
    const at = new Date(now).toISOString();
    sql.exec("INSERT INTO computers (id, name, size, state, created_at, last_active_at) VALUES (?, ?, ?, 'starting', ?, ?)", id, name, input.size, at, at);
    if (input.idempotencyKey !== undefined) {
      sql.exec("INSERT INTO idempotency (key, computer_id, created_at) VALUES (?, ?, ?)", input.idempotencyKey, id, now);
    }
    return { ok: true, id, name, size: input.size, replayed: false };
  }

  update(computer: ComputerView): void {
    this.ctx.storage.sql.exec(
      "UPDATE computers SET name = ?, size = ?, state = ?, created_at = ?, last_active_at = ?, snapshot_at = ?, error = ? WHERE id = ?",
      computer.name,
      computer.size,
      computer.state,
      computer.createdAt,
      computer.lastActiveAt,
      computer.snapshotAt ?? null,
      computer.error ?? null,
      computer.id,
    );
  }

  remove(id: string): boolean {
    const sql = this.ctx.storage.sql;
    const listed = sql.exec("SELECT 1 FROM computers WHERE id = ?", id).toArray().length > 0;
    sql.exec("DELETE FROM computers WHERE id = ?", id);
    sql.exec("DELETE FROM idempotency WHERE computer_id = ?", id);
    return listed;
  }

  has(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM computers WHERE id = ?", id).toArray().length > 0;
  }

  list(): ComputerView[] {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM computers ORDER BY created_at, id")
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        size: row.size as Size,
        state: row.state as State,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        ...(row.snapshot_at === null ? {} : { snapshotAt: row.snapshot_at }),
        ...(row.state === "error" && row.error !== null ? { error: row.error } : {}),
      }));
  }
}
