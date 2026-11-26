import { acceptedHistoryCommand, historyCommandHead, historyCommandPage, journalHistoryCommand } from "./history-command-journal.ts";
import { historyRecallStats, rankedHistoryRecall, type RecallCorpus } from "./history-recall.ts";
import { HISTORY_TABLES, type HistoryRow } from "./history-migration.ts";
import { clearHistoryValues, readHistoryValue, type HistorySql } from "./history-values.ts";
import type { HistoryAllocator, HistoryOperation } from "./history-shard-types.ts";
import { deleteHistoryMessageIndex, messageIndexFields, storeHistoryMessageValues } from "./history-message-index.ts";
export {
  deleteHistoryMessageIndex,
  initializeHistoryMessageIndex,
  storeHistoryMessageValues,
} from "./history-message-index.ts";

type Message = { id: string; at: number; role: string; kind: string; text?: string };
type Row = { rid: string; id: string; at: number; role: string; kind: string; text: string | null; json: string };

function first<T>(rows: Iterable<T>): T | undefined {
  return rows[Symbol.iterator]().next().value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid history text");
  return value;
}
function pageSize(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 500) : fallback;
}
function list(sql: HistorySql, thread: string, where: string, ...args: (string | number | null)[]) {
  return sql.exec<Row>(
    "SELECT CAST(rowid AS TEXT) rid,id,at,role,kind,text,json FROM messages WHERE thread_id=? " + where,
    thread,
    ...args,
  );
}
function leaf(sql: HistorySql, thread: string) {
  return (
    first(
      sql.exec<{ active_leaf_id: string | null }>("SELECT active_leaf_id FROM thread_state WHERE thread_id=?", thread),
    )?.active_leaf_id ?? null
  );
}
function setLeaf(sql: HistorySql, thread: string, id: string | null, allocate: HistoryAllocator) {
  const existing = first(sql.exec("SELECT 1 FROM thread_state WHERE thread_id=?", thread));
  if (existing) sql.exec("UPDATE thread_state SET active_leaf_id=? WHERE thread_id=?", id, thread);
  else
    sql.exec(
      "INSERT INTO thread_state(rowid,thread_id,active_leaf_id) VALUES(?,?,?)",
      allocate("thread_state"),
      thread,
      id,
    );
}
function write(sql: HistorySql, thread: string, value: unknown, updateOnly: boolean, allocate: HistoryAllocator) {
  const m = value as Message;
  if (
    !m ||
    typeof m.id !== "string" ||
    !Number.isSafeInteger(m.at) ||
    typeof m.role !== "string" ||
    typeof m.kind !== "string"
  )
    throw Error("Invalid history message");
  const prior = first(
    sql.exec<{ rid: string }>("SELECT CAST(rowid AS TEXT) rid FROM messages WHERE thread_id=? AND id=?", thread, m.id),
  );
  if (updateOnly && !prior) return;
  const row: HistoryRow = [
    prior?.rid ?? allocate("messages"),
    thread,
    m.id,
    String(m.at),
    m.role,
    m.kind,
    m.text ?? null,
    JSON.stringify(m),
  ];
  sql.exec(
    "INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET at=excluded.at,role=excluded.role,kind=excluded.kind,text=excluded.text,json=excluded.json",
    ...storeHistoryMessageValues(sql, row),
  );
}
export function historyOperationWrites(o: HistoryOperation): boolean {
  return [
    "messages.insert",
    "messages.append",
    "messages.update",
    "messages.import",
    "messages.leaf",
    "messages.delete",
    "messages.batch",
    "messages.command",
  ].includes(o.op);
}
function hydrate(sql: HistorySql, r: Row) {
  return JSON.parse(readHistoryValue(sql, "messages", r.rid, "json", r.json));
}
function readPage(sql: HistorySql, thread: string, o: HistoryOperation) {
  const backward = o.backward === true;
  const cmp = backward ? "<" : ">";
  const order = backward ? "DESC" : "ASC";
  const count = pageSize(o.limit, 64);
  const after = o.after == null ? null : text(o.after);
  const rows = list(
    sql,
    thread,
    (after === null ? "" : "AND rowid " + cmp + " CAST(? AS INTEGER) ") + "ORDER BY rowid " + order + " LIMIT ?",
    ...(after === null ? [] : [after]),
    count + 1,
  );
  const messages = [];
  let last: string | null = null;
  let bytes = 0;
  let more = false;
  for (const r of rows) {
    if (messages.length >= count || bytes >= 768 * 1024) {
      more = true;
      break;
    }
    const raw = readHistoryValue(sql, "messages", r.rid, "json", r.json);
    bytes += raw.length * 2;
    messages.push(JSON.parse(raw));
    last = r.rid;
  }
  return { messages, next: more ? last : null, hasMore: more, activeLeafId: leaf(sql, thread) };
}
export function executeHistoryOperation(
  sql: HistorySql,
  thread: string,
  o: HistoryOperation,
  allocate: HistoryAllocator,
): unknown {
  switch (o.op) {
    case "messages.page":
      return readPage(sql, thread, o);
    case "messages.insert":
    case "messages.append":
    case "messages.update":
      write(sql, thread, o.message, o.op === "messages.update", allocate);
      if (o.op === "messages.append") setLeaf(sql, thread, (o.message as Message).id, allocate);
      return null;
    case "messages.import":
      if (!Array.isArray(o.messages)) throw Error("Invalid import");
      if (
        first(
          sql.exec(
            "SELECT 1 FROM messages WHERE thread_id=? UNION ALL SELECT 1 FROM thread_state WHERE thread_id=? LIMIT 1",
            thread,
            thread,
          ),
        )
      )
        throw Error("Cannot import over an existing conversation");
      for (const m of o.messages) write(sql, thread, m, false, allocate);
      setLeaf(sql, thread, o.leaf == null ? null : text(o.leaf), allocate);
      return null;
    case "messages.commandHead": return historyCommandHead(sql);
    case "messages.commandPage": return historyCommandPage(sql,o);
    case "messages.command": {
      const key = text(o.key);
      if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid conversation command identity");
      if(o.rowid!==undefined){
        const accepted=acceptedHistoryCommand(sql,key);
        if(accepted)return accepted;
        executeHistoryOperation(sql,thread,{op:"messages.batch",operations:o.operations},allocate);
        return journalHistoryCommand(sql,o);
      }
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const saved = Array.from(
        sql.exec<{ result: ArrayBuffer }>(
          "SELECT result FROM history_command_results WHERE command=? ORDER BY part",
          key,
        ),
        (row) => decoder.decode(row.result, { stream: true }),
      );
      if (saved.length) return saved.join("") + decoder.decode();
      const value = text(o.result),
        bytes = new TextEncoder().encode(value);
      executeHistoryOperation(sql, thread, { op: "messages.batch", operations: o.operations }, allocate);
      for (let start = 0; start < bytes.length || start === 0; start += 384 * 1024) {
        sql.exec(
          "INSERT INTO history_command_results(command,part,result) VALUES(?,?,?)",
          key,
          start / (384 * 1024),
          bytes.slice(start, start + 384 * 1024).buffer,
        );
      }
      return value;
    }
    case "messages.batch":
      if (
        !Array.isArray(o.operations) ||
        !o.operations.every(
          (x) => x && ["messages.insert", "messages.append", "messages.update", "messages.leaf"].includes(x.op),
        )
      )
        throw Error("Invalid history batch");
      for (const item of o.operations) executeHistoryOperation(sql, thread, item, allocate);
      return null;
    case "messages.leaf":
      setLeaf(sql, thread, o.leaf == null ? null : text(o.leaf), allocate);
      return null;
    case "messages.delete":
      for (const t of HISTORY_TABLES) {
        sql.exec("DELETE FROM " + t);
        clearHistoryValues(sql, t);
      }
      deleteHistoryMessageIndex(sql);
      return null;
    case "messages.pending":
      return Boolean(
        first(
          sql.exec(
            "SELECT 1 FROM messages WHERE thread_id=? AND role='user' AND json_extract(json,'$.requestPending')=1 AND json_extract(json,'$.requestCancelled') IS NOT 1 LIMIT 1",
            thread,
          ),
        ),
      );
    case "messages.latest":
      return (
        first(
          sql.exec(
            "SELECT MAX(at) AS at FROM messages WHERE thread_id=?" +
              (o.person ? " AND role='user' AND kind='text' AND json_extract(json,'$.peerAsk') IS NULL" : ""),
            thread,
          ),
        )?.at ?? null
      );
    case "messages.cards": {
      const where = o.permission
        ? "json_extract(json,'$.card.requestType')='permission' AND json_extract(json,'$.card.answered') IS NULL AND COALESCE(json_extract(json,'$.card.dismissed'),0)=0 AND COALESCE(json_extract(json,'$.card.expired'),0)=0"
        : "json_extract(json,'$.card.autoAnswerAt') IS NOT NULL";
      return [...list(sql, thread, "AND kind='options' AND " + where + " ORDER BY rowid")].map((r) => hydrate(sql, r));
    }
    case "messages.references": {
      const fragment = text(o.fragment);
      if (
        first(
          sql.exec(
            "SELECT 1 FROM messages WHERE thread_id=? AND instr(json,?)>0 AND NOT EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='json') LIMIT 1",
            thread,
            fragment,
          ),
        )
      )
        return true;
      for (const r of list(
        sql,
        thread,
        "AND EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='json')",
      ))
        if (readHistoryValue(sql, "messages", r.rid, "json", r.json).includes(fragment)) return true;
      return false;
    }
    case "messages.text": {
      const r = first(list(sql, thread, "AND id=? AND kind='text' AND text IS NOT NULL", text(o.id)));
      if (!r) return null;
      const m=messageIndexFields(sql,r.rid,r.json);
      return {
        id: r.id,
        at: r.at,
        role: r.role,
        text: readHistoryValue(sql, "messages", r.rid, "text", r.text!),
        from: m.from?.name,
        peer: m.peerAsk?.name,
      };
    }
    default:
      return queryMessages(sql, thread, o);
  }
}

function queryMessages(sql: HistorySql, thread: string, o: HistoryOperation) {
  const limit = pageSize(o.limit, 40);
  const min = typeof o.since === "number" ? o.since : Number.MIN_SAFE_INTEGER;
  const max = typeof o.until === "number" ? o.until : Number.MAX_SAFE_INTEGER;
  if (o.op === "messages.search") {
    const needle = text(o.query).trim().toLowerCase();
    if (!needle || !limit) return [];
    const hits = [];
    for (const r of list(
      sql,
      thread,
      "AND ((kind='text' AND (instr(lower(text),?)>0 OR EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='text'))) OR (kind='activity' AND (json_extract(json,'$.extendedIndex')=1 OR instr(lower(json_extract(json,'$.tool.name')),?)>0))) ORDER BY at DESC,rowid",
      needle,needle,
    )) {
      const m = messageIndexFields(sql,r.rid,r.json);
      const hay =
        r.kind === "activity"
          ? String(m.tool?.name ?? "")
          : readHistoryValue(sql, "messages", r.rid, "text", r.text ?? "");
      const at = hay.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 60),
        end = Math.min(hay.length, at + needle.length + 90);
      const head = start ? "…" : "",
        snippet = head + hay.slice(start, end).replace(/\s+/g, " ").trim() + (end < hay.length ? "…" : "");
      const folded = needle.replace(/\s+/g, " "),
        index = snippet.toLowerCase().indexOf(folded);
      hits.push({
        rid: r.rid,
        threadId: thread,
        messageId: r.id,
        at: r.at,
        role: r.role,
        kind: r.kind,
        snippet,
        matchStart: index < 0 ? head.length : index,
        matchLength: index < 0 ? 0 : folded.length,
        ...(m.from?.name ? { from: m.from.name } : {}),
      });
      if (hits.length === limit) break;
    }
    return hits;
  }
  if (o.op === "messages.recent" || o.op === "messages.latestBot") {
    const latest = o.op === "messages.latestBot";
    return [
      ...list(
        sql,
        thread,
        "AND kind='text' AND text IS NOT NULL AND at>=? AND at<=? " +
          (latest
            ? "AND role='bot' AND (json_extract(json,'$.from.botId') IS NULL OR json_extract(json,'$.from.botId')=?) "
            : "") +
          "ORDER BY at DESC,rowid LIMIT ?",
        min,
        max,
        ...(latest ? [text(o.botId)] : []),
        latest ? 1 : limit,
      ),
    ].map((r) => {
      const m = messageIndexFields(sql,r.rid,r.json),
        head = (r.text ?? "")
          .slice(0, latest ? 400 : 240)
          .replace(/\s+/g, " ")
          .trim();
      return {
        rid: r.rid,
        threadId: thread,
        messageId: r.id,
        at: r.at,
        head,
        role: r.role,
        from: m.from?.name,
        peer: m.peerAsk?.name,
      };
    });
  }
  if (o.op === "messages.recall" || o.op === "messages.recallStats") {
    const terms = Array.isArray(o.terms) ? o.terms.map(text) : [];
    if (o.op === "messages.recallStats") return historyRecallStats(sql, terms);
    return rankedHistoryRecall(
      sql,
      thread,
      text(o.match),
      terms,
      Boolean(o.any),
      min,
      max,
      limit,
      o.corpus as RecallCorpus | undefined,
    );
  }
  throw Error("Unknown message history operation");
}
