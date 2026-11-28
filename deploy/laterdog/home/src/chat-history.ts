import type { SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import {
  HISTORY_PAGE_MAX,
  MAX_HISTORY_MESSAGE_BYTES,
  validHistoryChange,
  validHistoryRow,
  type HistoryChange,
  type HistoryLeaf,
  type HistoryPage,
  type HistoryRow,
  type HistoryStats,
  type StoredHistoryRow,
} from "../../../../shared/history-object.ts";

export { MAX_HISTORY_MESSAGE_BYTES, validHistoryRow, type HistoryRow };

export interface ChatHistoryPort {
  append(rows: HistoryRow[]): Promise<number>;
  page(after: string | null, limit: number): Promise<{ rows: HistoryRow[]; count: number }>;
  write(changes: HistoryChange[], leaf?: HistoryLeaf): Promise<number>;
  clear(): Promise<number>;
  pageBefore(before: number | null, limit: number): Promise<HistoryPage>;
  pageAfter(after: number, limit: number): Promise<HistoryPage>;
  stats(): Promise<HistoryStats>;
}

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

function columns(sql: Sql): Set<string> {
  return new Set(sql.exec("PRAGMA table_info(history)").toArray().map((row) => String(row.name)));
}

export function chatHistory(sql: Sql): ChatHistoryPort {
  sql.exec(`CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`);
  const known = columns(sql);
  if (!known.has("ord")) sql.exec("ALTER TABLE history ADD COLUMN ord INTEGER");
  sql.exec("CREATE INDEX IF NOT EXISTS history_at ON history (at, id)");
  sql.exec("CREATE INDEX IF NOT EXISTS history_ord ON history (ord)");
  sql.exec("CREATE TABLE IF NOT EXISTS history_state (key TEXT PRIMARY KEY, value TEXT)");
  const nextOrd = () => Number(sql.exec("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM history").toArray()[0]?.n ?? 1);
  const leaf = (): string | null => {
    const row = sql.exec("SELECT value FROM history_state WHERE key = 'leaf'").toArray()[0];
    return row && row.value !== null ? String(row.value) : null;
  };
  const stored = (row: Record<string, unknown>): StoredHistoryRow =>
    ({ id: String(row.id), ord: Number(row.ord), at: Number(row.at), json: String(row.json) });
  const page = (rows: Record<string, unknown>[], limit: number, newestFirst: boolean): HistoryPage => {
    const more = rows.length > limit;
    const kept = rows.slice(0, limit).map(stored);
    if (newestFirst) kept.reverse();
    return { rows: kept, more, leaf: leaf() };
  };
  const put = (row: HistoryRow) => {
    const held = sql.exec("SELECT ord FROM history WHERE id = ?", row.id).toArray()[0];
    if (held && held.ord !== null) sql.exec("UPDATE history SET at = ?, json = ? WHERE id = ?", row.at, row.json, row.id);
    else sql.exec("INSERT INTO history (id, at, json, ord) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json, ord = excluded.ord", row.id, row.at, row.json, nextOrd());
  };
  return {
    async append(rows) {
      let count = 0;
      for (const row of rows) {
        if (!validHistoryRow(row)) continue;
        put(row);
        count += 1;
      }
      return count;
    },
    async page(after, limit) {
      const size = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(limit)));
      const anchor = after ? sql.exec("SELECT at FROM history WHERE id = ?", after).toArray()[0] : undefined;
      const rows = (anchor
        ? sql.exec("SELECT id, at, json FROM history WHERE at > ? OR (at = ? AND id > ?) ORDER BY at, id LIMIT ?", anchor.at, anchor.at, after, size)
        : sql.exec("SELECT id, at, json FROM history ORDER BY at, id LIMIT ?", size)).toArray()
        .map((row) => ({ id: String(row.id), at: Number(row.at), json: String(row.json) }));
      const count = Number(sql.exec("SELECT COUNT(*) AS n FROM history").toArray()[0]?.n ?? 0);
      return { rows, count };
    },
    async write(changes, next) {
      let count = 0;
      for (const change of changes) {
        if (!validHistoryChange(change)) continue;
        if (change.op === "del") sql.exec("DELETE FROM history WHERE id = ?", change.id);
        else put(change);
        count += 1;
      }
      if (next) sql.exec("INSERT INTO history_state (key, value) VALUES ('leaf', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", next.id);
      return count;
    },
    async clear() {
      const count = Number(sql.exec("SELECT COUNT(*) AS n FROM history").toArray()[0]?.n ?? 0);
      sql.exec("DELETE FROM history");
      sql.exec("DELETE FROM history_state");
      return count;
    },
    async pageBefore(before, limit) {
      const size = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(limit)));
      const rows = before === null
        ? sql.exec("SELECT id, ord, at, json FROM history ORDER BY ord DESC LIMIT ?", size + 1).toArray()
        : sql.exec("SELECT id, ord, at, json FROM history WHERE ord < ? ORDER BY ord DESC LIMIT ?", before, size + 1).toArray();
      return page(rows, size, true);
    },
    async pageAfter(after, limit) {
      const size = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(limit)));
      return page(sql.exec("SELECT id, ord, at, json FROM history WHERE ord > ? ORDER BY ord LIMIT ?", after, size + 1).toArray(), size, false);
    },
    async stats() {
      const row = sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes, COALESCE(MAX(ord), 0) AS top FROM history").toArray()[0] ?? {};
      return { count: Number(row.n ?? 0), bytes: Number(row.bytes ?? 0), maxOrd: Number(row.top ?? 0), leaf: leaf() };
    },
  };
}

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type ChatHistoryLookup = ((home: string, chat: string) => ChatHistoryPort) | { chat(home: string, chat: string): ChatHistoryPort };

export async function serveHistory(body: Record<string, unknown>, claims: SignedCapabilityClaims, chats: ChatHistoryLookup): Promise<Response> {
  const chat = typeof chats === "function" ? chats(claims.home, claims.chat) : chats.chat(claims.home, claims.chat);
  const limit = whole(body.limit) ?? 100;
  switch (body.op) {
    case "append": {
      const rows = Array.isArray(body.messages) ? body.messages : [];
      if (!rows.every(validHistoryRow)) return answer(400, { error: "bad_messages" });
      return answer(200, { ok: true, stored: await chat.append(rows) });
    }
    case "page": {
      const after = typeof body.after === "string" ? body.after : null;
      return answer(200, { ok: true, ...(await chat.page(after, limit)) });
    }
    case "write": {
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (!changes.every(validHistoryChange)) return answer(400, { error: "bad_changes" });
      const leaf = body.leaf === undefined ? undefined : body.leaf && typeof body.leaf === "object" && "id" in body.leaf &&
        (typeof (body.leaf as HistoryLeaf).id === "string" || (body.leaf as HistoryLeaf).id === null) ? body.leaf as HistoryLeaf : false;
      if (leaf === false) return answer(400, { error: "bad_leaf" });
      return answer(200, { ok: true, stored: await chat.write(changes, leaf) });
    }
    case "clear":
      return answer(200, { ok: true, cleared: await chat.clear() });
    case "before": {
      const before = body.before === null || body.before === undefined ? null : whole(body.before);
      if (before === null && body.before !== null && body.before !== undefined) return answer(400, { error: "bad_cursor" });
      return answer(200, { ok: true, ...(await chat.pageBefore(before, limit)) });
    }
    case "after": {
      const after = whole(body.after);
      if (after === null) return answer(400, { error: "bad_cursor" });
      return answer(200, { ok: true, ...(await chat.pageAfter(after, limit)) });
    }
    case "stats":
      return answer(200, { ok: true, ...(await chat.stats()) });
    default:
      return answer(400, { error: "unknown_op" });
  }
}
