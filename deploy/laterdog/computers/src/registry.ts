// The registry: one Durable Object (named "registry") listing every computer, so listing is one call and the
// MAX_COMPUTERS cap and Idempotency-Key replays are decided in one place, one request at a time. Each computer's own
// Durable Object stays the source of truth and copies its summary here after every change.

import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import type { ComputerView, State } from "./computer";
import { newComputerId } from "./ids";
import type { Size } from "./inputs";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
  }

  /** Claims an id (and a slot under the cap) for a new computer, or returns the one an earlier request with this key made. */
  reserve(input: { name?: string; size: Size; idempotencyKey?: string; max: number }): Reservation {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
    if (input.idempotencyKey !== undefined) {
      const prior = sql.exec<{ computer_id: string }>("SELECT computer_id FROM idempotency WHERE key = ?", input.idempotencyKey).toArray()[0];
      const row = prior && sql.exec<Row>("SELECT * FROM computers WHERE id = ?", prior.computer_id).toArray()[0];
      if (row) return { ok: true, id: row.id, name: row.name, size: row.size as Size, replayed: true };
      // The computer that key created was deleted since; the key starts over.
      sql.exec("DELETE FROM idempotency WHERE key = ?", input.idempotencyKey);
    }
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM computers").one().n;
    if (count >= input.max) {
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

  /** Copies a computer's latest summary. Never inserts, so a late copy cannot bring back a deleted computer. */
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

  /** Forgets a computer; true when it was listed. */
  remove(id: string): boolean {
    const sql = this.ctx.storage.sql;
    const listed = sql.exec("SELECT 1 FROM computers WHERE id = ?", id).toArray().length > 0;
    sql.exec("DELETE FROM computers WHERE id = ?", id);
    sql.exec("DELETE FROM idempotency WHERE computer_id = ?", id);
    return listed;
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
