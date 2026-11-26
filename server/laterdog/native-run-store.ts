import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { NativeActivity, NativeRun, NativeRunDetail, NativeRunList } from "../../shared/native-runs.ts";

import { NativeHistoryRows, historyNativeOperationWrites, type NativeHistoryOperation } from "../../shared/history-native-operations.ts";
import type { HistorySql } from "../../shared/history-values.ts";
import type { NativeProjectionEvent } from "../../shared/native-run-projection.ts";

export { nativeRunLimits } from "../../shared/history-native-operations.ts";

export interface NativeRunDatabase {
  history?: {
    enabled(): boolean;
    execute<T>(threadId: string, operation: NativeHistoryOperation): T;
    many<T>(threadIds: readonly string[] | undefined, operation: NativeHistoryOperation): Array<{ threadId: string; result: T }>;
  };
  read<T>(read: (database: DatabaseSync) => T): T;
  write<T>(write: (database: DatabaseSync) => T): T;
}

export function ensureNativeRuns(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS native_runs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, started_at INTEGER NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS native_runs_thread ON native_runs(thread_id, started_at, id);
    CREATE TABLE IF NOT EXISTS native_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_id TEXT NOT NULL,
      at INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(run_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS native_run_events_run ON native_run_events(run_id, sequence);
    CREATE TABLE IF NOT EXISTS native_run_items (
      run_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(run_id, id)
    );
    CREATE INDEX IF NOT EXISTS native_run_items_sequence ON native_run_items(run_id, sequence);
    CREATE TABLE IF NOT EXISTS native_run_retention (thread_id TEXT PRIMARY KEY);
  `);
  const columns = database.prepare("PRAGMA table_info(native_runs)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "event_sequence")) database.exec("ALTER TABLE native_runs ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0");
  if (!columns.some(column => column.name === "sealed")) database.exec("ALTER TABLE native_runs ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0");
  database.prepare("UPDATE native_run_events SET json = 'null' WHERE json != 'null'").run();
}

export function deleteNativeRuns(database: DatabaseSync, threadId: string): void {
  database.prepare("DELETE FROM native_run_events WHERE run_id IN (SELECT id FROM native_runs WHERE thread_id = ?)").run(threadId);
  database.prepare("DELETE FROM native_run_items WHERE run_id IN (SELECT id FROM native_runs WHERE thread_id = ?)").run(threadId);
  database.prepare("DELETE FROM native_runs WHERE thread_id = ?").run(threadId);
  database.prepare("DELETE FROM native_run_retention WHERE thread_id = ?").run(threadId);
}

function localRows(db: DatabaseSync): NativeHistoryRows {
  const sql: HistorySql = {
    exec<T>(query: string, ...args: Array<string | number | null | ArrayBuffer>): T[] {
      const bindings: SQLInputValue[] = args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      return db.prepare(query).all(...bindings) as T[];
    },
  };
  return new NativeHistoryRows(sql);
}

export class NativeRunStore {
  private readonly access: NativeRunDatabase;
  constructor(access: NativeRunDatabase) { this.access = access; }

  private operation<T>(threadId: string, operation: NativeHistoryOperation): T {
    if (this.access.history?.enabled()) return this.access.history.execute<T>(threadId, operation);
    const call = (db: DatabaseSync) => localRows(db).operate(threadId, operation) as T;
    return historyNativeOperationWrites(operation) ? this.access.write(call) : this.access.read(call);
  }

  get(id: string, threadId?: string): NativeRun | undefined {
    if (threadId !== undefined) return this.operation<NativeRun | null>(threadId, { op: "native.get", id }) ?? undefined;
    if (this.access.history?.enabled()) throw Error("A conversation is required to read native activity");
    return this.access.read(db => localRows(db).get(id));
  }

  live(threadId: string): NativeRun[] {
    if (!this.access.history?.enabled()) return this.access.read(db => localRows(db).live(threadId));
    const runs: NativeRun[] = [];
    let before: string | undefined;
    do {
      const page: NativeRunList = this.operation(threadId, { op: "native.livePage", before });
      runs.push(...page.runs);
      before = page.nextCursor;
    } while (before);
    return runs;
  }

  list(threadId: string, before?: string, limit = 30): NativeRunList {
    return this.operation(threadId, { op: "native.list", before, limit });
  }

  detail(threadId: string, id: string, after?: string, limit = 100): NativeRunDetail | undefined {
    return this.operation<NativeRunDetail | null>(threadId, { op: "native.detail", id, after, limit }) ?? undefined;
  }

  observe(threadId: string, event: NativeProjectionEvent): NativeRun | undefined {
    return this.operation<NativeRun | null>(threadId, { op: "native.observe", event }) ?? undefined;
  }

  interrupt(threadId: string, id: string, revision: number, at: number, reason: string): NativeRun | undefined {
    return this.operation<NativeRun | null>(threadId, { op: "native.interrupt", id, revision, at, reason }) ?? undefined;
  }

  apply(id: string, eventId: string, at: number, _observation: unknown,
    project: (run: NativeRun | undefined, activity: (id: string) => NativeActivity | undefined) => { run: NativeRun; activity?: NativeActivity },
    options: { sequence?: number; final?: boolean } = {},
  ): NativeRun | undefined {
    if (this.access.history?.enabled()) throw Error("Native activity requires a conversation-scoped operation");
    return this.access.write(db => localRows(db).apply(id, eventId, at, project, options));
  }

  recoverInterrupted(now = Date.now()): void {
    if (this.access.history?.enabled()) { this.access.history.many(undefined, { op: "native.recover", at: now }); return; }
    this.access.write(db => localRows(db).recover(now));
  }

  pruneDetails(before: number, threadId?: string): void {
    if (threadId !== undefined) { this.operation(threadId, { op: "native.prune", before }); return; }
    if (this.access.history?.enabled()) { this.access.history.many(undefined, { op: "native.prune", before }); return; }
    this.access.write(db => localRows(db).prune(before));
  }
}
