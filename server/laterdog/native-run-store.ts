import type { DatabaseSync } from "node:sqlite";
import type { NativeActivity, NativeRun, NativeRunDetail, NativeRunList } from "../../shared/native-runs.ts";

export interface NativeRunDatabase {
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
  `);
}

export function deleteNativeRuns(database: DatabaseSync, threadId: string): void {
  database.prepare("DELETE FROM native_run_events WHERE run_id IN (SELECT id FROM native_runs WHERE thread_id = ?)").run(threadId);
  database.prepare("DELETE FROM native_run_items WHERE run_id IN (SELECT id FROM native_runs WHERE thread_id = ?)").run(threadId);
  database.prepare("DELETE FROM native_runs WHERE thread_id = ?").run(threadId);
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

  list(threadId: string, before?: string, limit = 30): NativeRunList {
    return this.access.read(database => {
      const take = Math.max(1, Math.min(100, limit));
      const cursor = before ? readRun(database, before) : undefined;
      if (before && (!cursor || cursor.threadId !== threadId)) return { runs: [] };
      const rows = (cursor
        ? database.prepare("SELECT json FROM native_runs WHERE thread_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(threadId, cursor.startedAt, cursor.startedAt, cursor.id, take + 1)
        : database.prepare("SELECT json FROM native_runs WHERE thread_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(threadId, take + 1)) as Array<{ json: string }>;
      const runs = rows.slice(0, take).map(row => JSON.parse(row.json) as NativeRun);
      return { runs, ...(rows.length > take ? { nextCursor: runs.at(-1)!.id } : {}) };
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

  apply(id: string, eventId: string, at: number, observation: unknown,
    project: (run: NativeRun | undefined, activity: (id: string) => NativeActivity | undefined) => { run: NativeRun; activity?: NativeActivity },
  ): NativeRun | undefined {
    return this.access.write(database => {
      const inserted = database.prepare("INSERT OR IGNORE INTO native_run_events(run_id, event_id, at, json) VALUES (?, ?, ?, ?)")
        .run(id, eventId, at, JSON.stringify(observation));
      if (!inserted.changes) return;
      const result = project(readRun(database, id), itemId => {
        const row = database.prepare("SELECT json FROM native_run_items WHERE run_id = ? AND id = ?").get(id, itemId) as { json: string } | undefined;
        return row ? JSON.parse(row.json) as NativeActivity : undefined;
      });
      const { run, activity } = result;
      if (activity) database.prepare("INSERT INTO native_run_items(run_id, id, sequence, json) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, id) DO UPDATE SET json = excluded.json")
        .run(id, activity.id, inserted.lastInsertRowid, JSON.stringify(activity));
      const items = database.prepare("SELECT COUNT(*) AS count FROM native_run_items WHERE run_id = ?").get(id) as { count: number };
      const removed = database.prepare("UPDATE native_run_events SET json = 'null' WHERE run_id = ? AND json != 'null' AND sequence NOT IN (SELECT sequence FROM native_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 5000)").run(id, id);
      if (items.count > 1000) {
        database.prepare("DELETE FROM native_run_items WHERE run_id = ? AND sequence NOT IN (SELECT sequence FROM native_run_items WHERE run_id = ? ORDER BY sequence DESC LIMIT 1000)").run(id, id);
        run.truncated = true;
      }
      if (removed.changes) run.truncated = true;
      run.activityCount = Math.max(run.activityCount, items.count);
      const current = run.observation === "live" ? database.prepare("SELECT json FROM native_run_items WHERE run_id = ? AND json_extract(json, '$.state') IN ('running', 'waiting') ORDER BY CASE json_extract(json, '$.kind') WHEN 'request' THEN 0 ELSE 1 END, sequence DESC LIMIT 1").get(id) as { json: string } | undefined : undefined;
      const selected = current ? JSON.parse(current.json) as NativeActivity : undefined;
      run.currentActivity = selected ? { id: selected.id, actorId: selected.actorId, kind: selected.kind, label: selected.label, state: selected.state } : undefined;
      saveRun(database, run);
      return run;
    });
  }

  recoverInterrupted(): void {
    this.access.write(database => {
      const rows = database.prepare("SELECT json FROM native_runs WHERE json_extract(json, '$.observation') = 'live'").all() as Array<{ json: string }>;
      for (const row of rows) {
        const run = JSON.parse(row.json) as NativeRun;
        run.observation = "interrupted";
        run.currentActivity = undefined;
        run.revision += 1;
        run.actors = run.actors.map(actor => ({ ...actor, canStop: false }));
        saveRun(database, run);
      }
    });
  }

  pruneDetails(before: number, threadId?: string): void {
    this.access.write(database => {
      const rows = database.prepare("SELECT json FROM native_runs WHERE started_at < ? AND (? IS NULL OR thread_id = ?) AND json_extract(json, '$.observation') != 'live'").all(before, threadId ?? null, threadId ?? null) as Array<{ json: string }>;
      for (const row of rows) {
        const run = JSON.parse(row.json) as NativeRun;
        const deleted = database.prepare("DELETE FROM native_run_items WHERE run_id = ?").run(run.id);
        database.prepare("UPDATE native_run_events SET json = 'null' WHERE run_id = ?").run(run.id);
        if (deleted.changes) { run.truncated = true; run.revision += 1; saveRun(database, run); }
      }
    });
  }
}
