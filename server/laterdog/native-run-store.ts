import type { DatabaseSync } from "node:sqlite";
import type { NativeActivity, NativeRun, NativeRunDetail, NativeRunList } from "../../shared/native-runs.ts";

export interface NativeRunDatabase {
  read<T>(read: (database: DatabaseSync) => T): T;
  write<T>(write: (database: DatabaseSync) => T): T;
}

export const nativeRunLimits = { legacyEvents: 5_000, activities: 1_000, detailBytes: 2 * 1024 * 1024, receipts: 1_000 };

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

const readRun = (database: DatabaseSync, id: string): NativeRun | undefined => {
  const row = database.prepare("SELECT json FROM native_runs WHERE id = ?").get(id) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as NativeRun : undefined;
};

const saveRun = (database: DatabaseSync, run: NativeRun): void => {
  database.prepare("INSERT INTO native_runs(id, thread_id, started_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
    .run(run.id, run.threadId, run.startedAt, JSON.stringify(run));
};

export class NativeRunStore {
  private readonly access: NativeRunDatabase;
  constructor(access: NativeRunDatabase) { this.access = access; }

  get(id: string): NativeRun | undefined {
    return this.access.read(database => readRun(database, id));
  }

  live(threadId: string): NativeRun[] {
    return this.access.read(database => (database.prepare("SELECT json FROM native_runs WHERE thread_id = ? AND json_extract(json, '$.observation') = 'live' ORDER BY started_at DESC, id DESC").all(threadId) as Array<{ json: string }>).map(row => JSON.parse(row.json) as NativeRun));
  }

  list(threadId: string, before?: string, limit = 30): NativeRunList {
    return this.access.read(database => {
      const take = Math.max(1, Math.min(100, limit));
      const cursor = before ? readRun(database, before) : undefined;
      if (before && (!cursor || cursor.threadId !== threadId)) return { runs: [], historyIncomplete: true };
      const historyIncomplete = !!database.prepare("SELECT 1 FROM native_run_retention WHERE thread_id = ?").get(threadId);
      const rows = (cursor
        ? database.prepare("SELECT json FROM native_runs WHERE thread_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(threadId, cursor.startedAt, cursor.startedAt, cursor.id, take + 1)
        : database.prepare("SELECT json FROM native_runs WHERE thread_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(threadId, take + 1)) as Array<{ json: string }>;
      const runs = rows.slice(0, take).map(row => JSON.parse(row.json) as NativeRun);
      return { runs, ...(historyIncomplete ? { historyIncomplete: true } : {}), ...(rows.length > take ? { nextCursor: runs.at(-1)!.id } : {}) };
    });
  }

  detail(threadId: string, id: string, after?: string, limit = 100): NativeRunDetail | undefined {
    return this.access.read(database => {
      const run = readRun(database, id);
      if (!run || run.threadId !== threadId) return;
      const cursor = after ? Number(after) : 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) return;
      const take = Math.max(1, Math.min(200, limit));
      const rows = database.prepare("SELECT sequence, json FROM native_run_items WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
        .all(id, cursor, take + 1) as Array<{ sequence: number; json: string }>;
      return { run, activities: rows.slice(0, take).map(row => JSON.parse(row.json) as NativeActivity),
        ...(rows.length > take ? { nextCursor: String(rows[take - 1].sequence) } : {}) };
    });
  }

  apply(id: string, eventId: string, at: number, _observation: unknown,
    project: (run: NativeRun | undefined, activity: (id: string) => NativeActivity | undefined) => { run: NativeRun; activity?: NativeActivity },
    options: { sequence?: number; final?: boolean } = {},
  ): NativeRun | undefined {
    return this.access.write(database => {
      const checkpoint = database.prepare("SELECT event_sequence, sealed FROM native_runs WHERE id = ?").get(id) as { event_sequence: number; sealed: number } | undefined;
      if (checkpoint?.sealed) return;
      const ordered = Number.isSafeInteger(options.sequence) && options.sequence! > 0;
      if (ordered && options.sequence! <= (checkpoint?.event_sequence ?? 0)) return;
      if (!ordered) {
        if (database.prepare("SELECT 1 FROM native_run_events WHERE run_id = ? AND event_id = ?").get(id, eventId)) return;
        const retained = database.prepare("SELECT COUNT(*) AS count FROM native_run_events WHERE run_id = ?").get(id) as { count: number };
        if (retained.count >= nativeRunLimits.legacyEvents && !options.final) {
          const run = readRun(database, id);
          if (!run || run.limitations.includes("This harness reached the legacy event recording limit.")) return;
          run.truncated = true;
          run.limitations.push("This harness reached the legacy event recording limit.");
          run.revision += 1;
          saveRun(database, run);
          return run;
        }
        if (retained.count < nativeRunLimits.legacyEvents) database.prepare("INSERT INTO native_run_events(run_id, event_id, at, json) VALUES (?, ?, ?, 'null')").run(id, eventId, at);
      }
      const result = project(readRun(database, id), itemId => {
        const row = database.prepare("SELECT json FROM native_run_items WHERE run_id = ? AND id = ?").get(id, itemId) as { json: string } | undefined;
        return row ? JSON.parse(row.json) as NativeActivity : undefined;
      });
      const { run, activity } = result;
      if (activity) database.prepare("INSERT INTO native_run_items(run_id, id, sequence, json) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, id) DO UPDATE SET json = excluded.json")
        .run(id, activity.id, run.revision, JSON.stringify(activity));
      const items = database.prepare("SELECT id, length(CAST(json AS BLOB)) AS bytes FROM native_run_items WHERE run_id = ? ORDER BY CASE WHEN json_extract(json, '$.state') IN ('running', 'waiting') THEN 0 ELSE 1 END, sequence DESC").all(id) as Array<{ id: string; bytes: number }>;
      let bytes = 0;
      for (const [index, item] of items.entries()) {
        bytes += item.bytes;
        if (index < nativeRunLimits.activities && bytes <= nativeRunLimits.detailBytes) continue;
        database.prepare("DELETE FROM native_run_items WHERE run_id = ? AND id = ?").run(id, item.id);
        run.truncated = true;
      }
      run.activityCount = Math.max(run.activityCount, items.length);
      const current = run.observation === "live" ? database.prepare("SELECT json FROM native_run_items WHERE run_id = ? AND json_extract(json, '$.state') IN ('running', 'waiting') ORDER BY CASE json_extract(json, '$.kind') WHEN 'request' THEN 0 ELSE 1 END, sequence DESC LIMIT 1").get(id) as { json: string } | undefined : undefined;
      const selected = current ? JSON.parse(current.json) as NativeActivity : undefined;
      run.currentActivity = selected ? { id: selected.id, actorId: selected.actorId, kind: selected.kind, label: selected.label, state: selected.state } : undefined;
      saveRun(database, run);
      if (ordered) database.prepare("UPDATE native_runs SET event_sequence = ? WHERE id = ?").run(options.sequence!, id);
      if (!checkpoint || options.final) this.capReceipts(database, run.threadId);
      return run;
    });
  }

  private capReceipts(database: DatabaseSync, threadId: string): void {
    const expired = database.prepare("SELECT id FROM native_runs WHERE thread_id = ? AND json_extract(json, '$.observation') != 'live' ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?").all(threadId, nativeRunLimits.receipts) as Array<{ id: string }>;
    if (!expired.length) return;
    database.prepare("INSERT OR IGNORE INTO native_run_retention(thread_id) VALUES (?)").run(threadId);
    for (const { id } of expired) {
      database.prepare("DELETE FROM native_run_events WHERE run_id = ?").run(id);
      database.prepare("DELETE FROM native_run_items WHERE run_id = ?").run(id);
      database.prepare("DELETE FROM native_runs WHERE id = ?").run(id);
    }
  }

  recoverInterrupted(): void {
    this.access.write(database => {
      const rows = database.prepare("SELECT json FROM native_runs WHERE json_extract(json, '$.observation') = 'live'").all() as Array<{ json: string }>;
      const threads = new Set<string>();
      for (const row of rows) {
        const run = JSON.parse(row.json) as NativeRun;
        threads.add(run.threadId);
        run.observation = "interrupted";
        run.currentActivity = undefined;
        run.revision += 1;
        run.actors = run.actors.map(actor => ({ ...actor, canStop: false }));
        saveRun(database, run);
        database.prepare("UPDATE native_runs SET sealed = 1 WHERE id = ?").run(run.id);
        database.prepare("DELETE FROM native_run_events WHERE run_id = ?").run(run.id);
      }
      for (const threadId of threads) this.capReceipts(database, threadId);
    });
  }

  pruneDetails(before: number, threadId?: string): void {
    this.access.write(database => {
      const rows = database.prepare("SELECT json FROM native_runs WHERE started_at < ? AND (? IS NULL OR thread_id = ?) AND json_extract(json, '$.observation') != 'live'").all(before, threadId ?? null, threadId ?? null) as Array<{ json: string }>;
      for (const row of rows) {
        const run = JSON.parse(row.json) as NativeRun;
        const deleted = database.prepare("DELETE FROM native_run_items WHERE run_id = ?").run(run.id);
        database.prepare("DELETE FROM native_run_events WHERE run_id = ?").run(run.id);
        database.prepare("UPDATE native_runs SET sealed = 1 WHERE id = ?").run(run.id);
        if (deleted.changes || !run.truncated) {
          run.truncated = true;
          run.revision += 1;
          run.actors = run.actors.map(actor => ({ id: actor.id, parentId: actor.parentId, kind: actor.kind, label: actor.label, state: actor.state, startedAt: actor.startedAt, endedAt: actor.endedAt, canStop: false }));
          run.currentActivity = undefined;
          saveRun(database, run);
        }
      }
    });
  }
}
