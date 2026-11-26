import { HISTORY_TABLES, type HistoryRow } from "./history-migration.ts";
import { clearHistoryValues, readHistoryValue, type HistorySql } from "./history-values.ts";
import type { HistoryAllocator, HistoryOperation } from "./history-shard-types.ts";
import { deleteHistoryMessageIndex, storeHistoryMessageValues } from "./history-message-index.ts";
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
      return {
        id: r.id,
        at: r.at,
        role: r.role,
        text: readHistoryValue(sql, "messages", r.rid, "text", r.text!),
        from: hydrate(sql, r).from?.name,
        peer: hydrate(sql, r).peerAsk?.name,
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
    const pattern = "%" + needle.replace(/([\\%_])/g, "\\$1") + "%";
    const hits = [];
    for (const r of list(
      sql,
      thread,
      `AND ((kind='text' AND (lower(text) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='text'))) OR (kind='activity' AND lower(json_extract(json,'$.tool.name')) LIKE ? ESCAPE '\\')) ORDER BY at DESC,rowid`,
      pattern,
      pattern,
    )) {
      const m = JSON.parse(r.json);
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
      const m = JSON.parse(r.json),
        head = (r.text ?? "")
          .slice(0, latest ? 400 : 240)
          .replace(/\s+/g, " ")
          .trim();
      return {
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
  if (o.op === "messages.recall") {
    type Match = {
      id: string;
      at: number;
      role: string;
      kind: string;
      head: string;
      name: string | null;
      peer: string | null;
      snippet: string;
      score: number;
    };
    const match = text(o.match);
    const normal = [
      ...sql.exec<Match>(
        "SELECT m.id,m.at,m.role,m.kind,substr(m.text,1,160) head,json_extract(m.json,'$.from.name') name,json_extract(m.json,'$.peerAsk.name') peer,snippet(messages_fts,0,'[',']','…',48) snippet,bm25(messages_fts) score FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid WHERE messages_fts MATCH ? AND m.thread_id=? AND m.at BETWEEN ? AND ? AND m.kind IN ('text','digest') ORDER BY (m.kind='digest'),score,m.at DESC LIMIT ?",
        match,
        thread,
        min,
        max,
        limit,
      ),
    ];
    const byId = new Map(normal.map((r) => [r.id, r]));
    const terms = Array.isArray(o.terms) ? o.terms.map(text) : [];
    const found = new Map<string, { row: Match; terms: Set<string> }>();
    for (const term of terms) {
      for (const r of sql.exec<Match>(
        "SELECT m.id,m.at,m.role,m.kind,substr(m.text,1,160) head,json_extract(m.json,'$.from.name') name,json_extract(m.json,'$.peerAsk.name') peer,snippet(history_text_parts,0,'[',']','…',48) snippet,bm25(history_text_parts) score FROM history_text_parts JOIN messages m ON m.rowid=CAST(history_text_parts.entry AS INTEGER) WHERE history_text_parts MATCH ? AND m.thread_id=? AND m.at BETWEEN ? AND ? AND m.kind IN ('text','digest')",
        term,
        thread,
        min,
        max,
      )) {
        let hit = found.get(r.id);
        if (!hit) {
          hit = { row: r, terms: new Set() };
          found.set(r.id, hit);
        }
        if (r.score < hit.row.score) hit.row = r;
        hit.terms.add(term);
      }
    }
    for (const [id, x] of found)
      if (o.any || x.terms.size === new Set(terms).size) {
        if (!byId.has(id)) byId.set(id, x.row);
      }
    return [...byId.values()]
      .sort((a, b) => Number(a.kind === "digest") - Number(b.kind === "digest") || a.score - b.score || b.at - a.at)
      .slice(0, limit);
  }
  throw Error("Unknown message history operation");
}
