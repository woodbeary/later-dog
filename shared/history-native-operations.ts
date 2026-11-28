import type { HistoryAllocator, HistoryOperation } from "./history-shard-types.ts";
import type { HistoryTable } from "./history-migration.ts";
import { clearHistoryValues, readHistoryValue, storeHistoryValue, type HistorySql } from "./history-values.ts";
import { projectNativeEvent, type NativeProjectionEvent } from "./native-run-projection.ts";
import type { NativeActivity, NativeRun, NativeRunDetail, NativeRunList } from "./native-runs.ts";

export const nativeRunLimits = { legacyEvents: 5_000, activities: 1_000, detailBytes: 2 * 1024 * 1024, receipts: 1_000 };
type JsonTable = "native_runs" | "native_run_items";
type JsonRow = { rid: string; json: string };
type SqlValue = string | number | null | ArrayBuffer;
type Project = (run: NativeRun | undefined, activity: (id: string) => NativeActivity | undefined) => { run: NativeRun; activity?: NativeActivity };
export type NativeHistoryOperation =
  | { op: "native.get"; id: string }
  | { op: "native.livePage"; before?: string }
  | { op: "native.list"; before?: string; limit?: number }
  | { op: "native.detail"; id: string; after?: string; limit?: number }
  | { op: "native.observe"; event: NativeProjectionEvent }
  | { op: "native.interrupt"; id: string; revision: number; at: number; reason: string }
  | { op: "native.recover"; at: number }
  | { op: "native.prune"; before: number };

const openState = (state: NativeRun["state"]): boolean => state === "running" || state === "waiting" || state === "paused";
const fields = "CAST(rowid AS TEXT) AS rid, json";

export function nativeHistoryProjection(table: HistoryTable, column: string, value: string): string {
  if (column !== "json") return value;
  if (table !== "native_runs" && table !== "native_run_items") return "null";
  const row = JSON.parse(value);
  return table === "native_runs"
    ? JSON.stringify({ state: row.state, observation: row.observation })
    : JSON.stringify({ state: row.state, kind: row.kind });
}

export function historyNativeOperationWrites(operation: { op: string }): boolean {
  return ["native.observe", "native.interrupt", "native.prune", "native.recover"].includes(operation.op);
}

export class NativeHistoryRows {
  private readonly sql: HistorySql;
  private readonly allocate?: HistoryAllocator;
  constructor(sql: HistorySql, allocate?: HistoryAllocator) {
    this.sql = sql;
    this.allocate = allocate;
  }

  private one<T extends Record<string, SqlValue>>(query: string, ...args: SqlValue[]): T | undefined {
    return this.sql.exec<T>(query, ...args)[Symbol.iterator]().next().value;
  }

  private parse<T>(table: JsonTable, row: JsonRow): T {
    return JSON.parse(this.allocate ? readHistoryValue(this.sql, table, row.rid, "json", row.json) : row.json);
  }

  private value(table: JsonTable, rid: string | null, value: NativeActivity | NativeRun): string {
    const raw = JSON.stringify(value);
    if (!this.allocate || rid === null) return raw;
    return storeHistoryValue(this.sql, table, rid, "json", raw, nativeHistoryProjection(table, "json", raw));
  }

  get(id: string, threadId?: string): NativeRun | undefined {
    const row = this.one<JsonRow>(`SELECT ${fields} FROM native_runs WHERE id = ? AND (? IS NULL OR thread_id = ?)`, id, threadId ?? null, threadId ?? null);
    return row && this.parse("native_runs", row);
  }

  private saveRun(run: NativeRun, existing?: string): void {
    const rid = existing ?? this.allocate?.("native_runs") ?? null;
    const raw = this.value("native_runs", rid, run);
    if (existing) this.sql.exec("UPDATE native_runs SET json = ? WHERE rowid = ?", raw, existing);
    else this.sql.exec("INSERT INTO native_runs(rowid,id,thread_id,started_at,json) VALUES (?,?,?,?,?)", rid, run.id, run.threadId, run.startedAt, raw);
  }

  live(threadId: string): NativeRun[] {
    return Array.from(this.sql.exec<JsonRow>(`SELECT ${fields} FROM native_runs WHERE thread_id = ? AND json_extract(json,'$.observation') = 'live' ORDER BY started_at DESC,id DESC`, threadId), row => this.parse("native_runs", row));
  }

  private bytes(table: JsonTable): string {
    const physical = "length(CAST(i.json AS BLOB))";
    return this.allocate
      ? `COALESCE((SELECT SUM(length(bytes)) FROM history_values WHERE relation='${table}' AND entry=CAST(i.rowid AS TEXT) AND field='json'),${physical})`
      : physical;
  }

  list(threadId: string, before?: string, limit = 30, liveOnly = false): NativeRunList {
    const take = Math.max(1, Math.min(100, limit));
    const cursor = before ? this.one<{ started_at: number }>("SELECT started_at FROM native_runs WHERE id = ? AND thread_id = ?", before, threadId) : undefined;
    if (before && !cursor) return { runs: [], historyIncomplete: true };
    const historyIncomplete = !liveOnly && !!this.one("SELECT 1 FROM native_run_retention WHERE thread_id = ?", threadId);
    const select = `SELECT id,${this.bytes("native_runs")} AS bytes FROM native_runs i WHERE thread_id = ?` + (liveOnly ? " AND json_extract(json,'$.observation') = 'live'" : "");
    const tail = " ORDER BY started_at DESC,id DESC LIMIT ?";
    const rows = cursor
      ? this.sql.exec<{ id: string; bytes: number }>(select + " AND (started_at < ? OR (started_at = ? AND id < ?))" + tail, threadId, cursor.started_at, cursor.started_at, before!, take + 1)
      : this.sql.exec<{ id: string; bytes: number }>(select + tail, threadId, take + 1);
    const runs: NativeRun[] = [];
    let bytes = 0;
    let nextCursor: string | undefined;
    for (const row of rows) {
      if (runs.length >= take || (this.allocate && runs.length && bytes + row.bytes > nativeRunLimits.detailBytes)) {
        nextCursor = runs.at(-1)!.id;
        break;
      }
      runs.push(this.get(row.id, threadId)!);
      bytes += row.bytes;
    }
    return { runs, ...(historyIncomplete ? { historyIncomplete: true } : {}), ...(nextCursor ? { nextCursor } : {}) };
  }

  detail(threadId: string, id: string, after?: string, limit = 100): NativeRunDetail | undefined {
    const run = this.get(id, threadId);
    const cursor = after ? Number(after) : 0;
    if (!run || !Number.isSafeInteger(cursor) || cursor < 0) return;
    const take = Math.max(1, Math.min(200, limit));
    const rows = Array.from(this.sql.exec<JsonRow & { sequence: number }>(`SELECT ${fields},sequence FROM native_run_items WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, id, cursor, take + 1));
    return { run, activities: rows.slice(0, take).map(row => this.parse("native_run_items", row)),
      ...(rows.length > take ? { nextCursor: String(rows[take - 1].sequence) } : {}) };
  }

  apply(id: string, eventId: string, at: number, project: Project, options: { sequence?: number; final?: boolean } = {}, threadId?: string): NativeRun | undefined {
    const check = this.one<JsonRow & { event_sequence: number; sealed: number; thread_id: string }>(`SELECT ${fields},thread_id,event_sequence,sealed FROM native_runs WHERE id = ?`, id);
    if (check && (check.sealed || (threadId !== undefined && check.thread_id !== threadId))) return;
    const ordered = Number.isSafeInteger(options.sequence) && options.sequence! > 0;
    if (ordered && options.sequence! <= (check?.event_sequence ?? 0)) return;
    if (!ordered) {
      if (this.one("SELECT 1 FROM native_run_events WHERE run_id = ? AND event_id = ?", id, eventId)) return;
      const retained = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM native_run_events WHERE run_id = ?", id)!.n;
      if (retained >= nativeRunLimits.legacyEvents && !options.final) {
        if (!check) return;
        const run = this.parse<NativeRun>("native_runs", check);
        const notice = "This harness reached the legacy event recording limit.";
        if (run.limitations.includes(notice)) return;
        run.truncated = true;
        run.limitations.push(notice);
        run.revision += 1;
        this.saveRun(run, check.rid);
        return run;
      }
      if (retained < nativeRunLimits.legacyEvents) this.sql.exec("INSERT INTO native_run_events(sequence,run_id,event_id,at,json) VALUES (?,?,?,?,'null')", this.allocate?.("native_run_events") ?? null, id, eventId, at);
    }
    const previous = check && this.parse<NativeRun>("native_runs", check);
    const moved = new Map((previous?.actors ?? []).flatMap(actor => actor.lastActivityAt === undefined ? [] : [[actor.id, actor.lastActivityAt] as const]));
    const { run, activity } = project(previous, itemId => {
      const row = this.one<JsonRow>(`SELECT ${fields} FROM native_run_items WHERE run_id = ? AND id = ?`, id, itemId);
      return row && this.parse<NativeActivity>("native_run_items", row);
    });
    if (run.id !== id || (threadId !== undefined && run.threadId !== threadId)) throw Error("Activity belongs to another conversation");
    if (activity) run.lastActivityAt = Math.max(run.lastActivityAt ?? at, at);
    for (const actor of run.actors) {
      const latest = Math.max(actor.lastActivityAt ?? 0, moved.get(actor.id) ?? 0, activity?.actorId === actor.id ? at : 0);
      if (latest) actor.lastActivityAt = latest;
    }
    if (activity) {
      const old = this.one<{ rid: string }>("SELECT CAST(rowid AS TEXT) AS rid FROM native_run_items WHERE run_id = ? AND id = ?", id, activity.id);
      const rid = old?.rid ?? this.allocate?.("native_run_items") ?? null;
      const raw = this.value("native_run_items", rid, activity);
      if (old) this.sql.exec("UPDATE native_run_items SET json = ? WHERE rowid = ?", raw, old.rid);
      else this.sql.exec("INSERT INTO native_run_items(rowid,run_id,id,sequence,json) VALUES (?,?,?,?,?)", rid, id, activity.id, run.revision, raw);
    }
    const items = Array.from(this.sql.exec<{ rid: string; bytes: number }>(`SELECT CAST(i.rowid AS TEXT) AS rid,${this.bytes("native_run_items")} AS bytes FROM native_run_items i WHERE run_id = ? ORDER BY CASE WHEN json_extract(json,'$.state') IN ('running','waiting') THEN 0 ELSE 1 END,sequence DESC`, id));
    let bytes = 0;
    for (const [index, item] of items.entries()) {
      bytes += item.bytes;
      if (index < nativeRunLimits.activities && bytes <= nativeRunLimits.detailBytes) continue;
      if (this.allocate) clearHistoryValues(this.sql, "native_run_items", item.rid);
      this.sql.exec("DELETE FROM native_run_items WHERE rowid = ?", item.rid);
      run.truncated = true;
    }
    run.activityCount = Math.max(run.activityCount, items.length);
    const current = run.observation === "live" ? this.one<JsonRow>(`SELECT ${fields} FROM native_run_items WHERE run_id = ? AND json_extract(json,'$.state') IN ('running','waiting') ORDER BY CASE json_extract(json,'$.kind') WHEN 'request' THEN 0 ELSE 1 END,sequence DESC LIMIT 1`, id) : undefined;
    const selected = current && this.parse<NativeActivity>("native_run_items", current);
    run.currentActivity = selected ? { id: selected.id, actorId: selected.actorId, kind: selected.kind, label: selected.label, state: selected.state, startedAt: selected.startedAt } : undefined;
    this.saveRun(run, check?.rid);
    if (ordered) this.sql.exec("UPDATE native_runs SET event_sequence = ? WHERE id = ?", options.sequence!, id);
    if (!check || options.final) this.capReceipts(run.threadId);
    return run;
  }

  private deleteChildren(table: "native_run_items" | "native_run_events", id: string): void {
    if (this.allocate) this.sql.exec(`DELETE FROM history_values WHERE relation = ? AND entry IN (SELECT CAST(rowid AS TEXT) FROM ${table} WHERE run_id = ?)`, table, id);
    this.sql.exec(`DELETE FROM ${table} WHERE run_id = ?`, id);
  }

  private capReceipts(threadId: string): void {
    const expired = Array.from(this.sql.exec<{ id: string; rid: string }>("SELECT id,CAST(rowid AS TEXT) AS rid FROM native_runs WHERE thread_id = ? AND json_extract(json,'$.observation') != 'live' ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET ?", threadId, nativeRunLimits.receipts));
    if (!expired.length) return;
    if (!this.one("SELECT 1 FROM native_run_retention WHERE thread_id = ?", threadId)) this.sql.exec("INSERT INTO native_run_retention(rowid,thread_id) VALUES (?,?)", this.allocate?.("native_run_retention") ?? null, threadId);
    for (const row of expired) {
      this.deleteChildren("native_run_events", row.id);
      this.deleteChildren("native_run_items", row.id);
      if (this.allocate) clearHistoryValues(this.sql, "native_runs", row.rid);
      this.sql.exec("DELETE FROM native_runs WHERE rowid = ?", row.rid);
    }
  }

  private *maintenanceRows(threadId: string | undefined, condition: string, ...bindings: SqlValue[]): Generator<JsonRow> {
    let cursor: string | null = null;
    for (;;) {
      const page: Array<{ id: string }> = Array.from(this.sql.exec<{ id: string }>(`SELECT id FROM native_runs WHERE (? IS NULL OR thread_id = ?) AND (? IS NULL OR id > ?) AND (${condition}) ORDER BY id LIMIT 64`, threadId ?? null, threadId ?? null, cursor, cursor, ...bindings));
      if (!page.length) return;
      for (const { id } of page) yield this.one<JsonRow>(`SELECT ${fields} FROM native_runs WHERE id = ?`, id)!;
      cursor = page.at(-1)!.id;
    }
  }

  recover(now: number, threadId?: string): void {
    const rows = this.maintenanceRows(threadId, "json_extract(json,'$.observation') = 'live' OR json_extract(json,'$.state') IN ('running','waiting','paused')");
    const threads = new Set<string>();
    for (const row of rows) {
      const run = this.parse<NativeRun>("native_runs", row);
      threads.add(run.threadId);
      if (run.observation === "live") run.observation = "interrupted";
      run.currentActivity = undefined;
      run.revision += 1;
      if (openState(run.state)) { run.state = "stopped"; run.endedAt ??= now; }
      run.actors = run.actors.map(actor => openState(actor.state) ? { ...actor, state: "stopped", endedAt: actor.endedAt ?? now, canStop: false } : { ...actor, canStop: false });
      this.saveRun(run, row.rid);
      this.sql.exec("UPDATE native_runs SET sealed = 1 WHERE rowid = ?", row.rid);
      this.deleteChildren("native_run_events", run.id);
    }
    for (const thread of threads) this.capReceipts(thread);
  }

  prune(before: number, threadId?: string): void {
    const rows = this.maintenanceRows(threadId, "started_at < ? AND json_extract(json,'$.observation') != 'live'", before);
    for (const row of rows) {
      const run = this.parse<NativeRun>("native_runs", row);
      const hasItems = this.one("SELECT 1 FROM native_run_items WHERE run_id = ? LIMIT 1", run.id);
      this.deleteChildren("native_run_items", run.id);
      this.deleteChildren("native_run_events", run.id);
      this.sql.exec("UPDATE native_runs SET sealed = 1 WHERE rowid = ?", row.rid);
      if (hasItems || !run.truncated) {
        run.truncated = true;
        run.revision += 1;
        run.actors = run.actors.map(actor => ({ id: actor.id, parentId: actor.parentId, kind: actor.kind, label: actor.label, state: actor.state, startedAt: actor.startedAt, endedAt: actor.endedAt, canStop: false }));
        run.currentActivity = undefined;
        this.saveRun(run, row.rid);
      }
    }
  }

  operate(threadId: string, operation: NativeHistoryOperation): unknown {
    switch (operation.op) {
      case "native.get": return this.get(operation.id, threadId) ?? null;
      case "native.livePage": return this.list(threadId, operation.before, 100, true);
      case "native.list": return this.list(threadId, operation.before, operation.limit);
      case "native.detail": return this.detail(threadId, operation.id, operation.after, operation.limit) ?? null;
      case "native.observe": {
        const event = operation.event;
        return this.apply(event.id, event.eventId, event.at, (previous, item) => projectNativeEvent(threadId, event, previous, item), { sequence: event.sequence, final: event.type === "turn.completed" || event.type === "session.exited" }, threadId) ?? null;
      }
      case "native.interrupt": {
        const { id, revision, at, reason } = operation;
        if (this.get(id, threadId)?.revision !== revision) return null;
        return this.apply(id, `interrupted:${revision}`, at, previous => ({
          run: { ...previous!, observation: "interrupted", currentActivity: undefined, revision: previous!.revision + 1, actors: previous!.actors.map(actor => ({ ...actor, canStop: false })) },
          activity: { id: "observation-interrupted", actorId: "parent", kind: "notice", label: "Activity interrupted", text: reason, state: "stopped", startedAt: at, endedAt: at },
        }), { final: true }, threadId) ?? null;
      }
      case "native.recover": this.recover(operation.at, threadId); return null;
      case "native.prune": this.prune(operation.before, threadId); return null;
      default: throw Error("Unknown native activity operation");
    }
  }
}

export function executeHistoryNativeOperation(sql: HistorySql, threadId: string, operation: HistoryOperation, allocateRowId: HistoryAllocator): unknown {
  return new NativeHistoryRows(sql, allocateRowId).operate(threadId, operation as NativeHistoryOperation);
}
