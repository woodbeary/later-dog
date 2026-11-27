import { ftsQuery, rangeClause, substringSnippet, textSum } from "../../../../shared/search-index-query.ts";
import {
  INDEX_FEED_MAX_ITEMS,
  INDEX_SCOPE_MAX,
  INDEX_TEXT_MAX_CHARS,
  type IndexFeedBatch,
  type IndexHasAnswer,
  type IndexHasRequest,
  type IndexFilesRequest,
  type IndexMemoryText,
  type IndexMemoryHit,
  type IndexMemoryRequest,
  type IndexMessage,
  type IndexRecallHit,
  type IndexRecallRequest,
  type IndexRecentRequest,
  type IndexSearchHit,
  type IndexSearchRequest,
  type IndexStats,
} from "../../../../shared/search-index-protocol.ts";

export type SqlValue = string | number | null;

export interface SqlPort {
  all<T>(query: string, ...params: SqlValue[]): T[];
  script(sql: string): void;
  batch(work: () => void): void;
  size(): number;
}

const SNIPPET_TOKENS = 48;
const RECENT_HEAD_CHARS = 240;
const SUBSTRING_CANDIDATES = 2_000;
const SHORT_NEEDLE_WINDOW = 50_000;
const MAX_LIMIT = 1_000;
export const BROAD_MATCHES = 20_000;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const KIND = /^[a-z_-]{1,32}$/;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    rid INTEGER PRIMARY KEY,
    chat TEXT NOT NULL,
    id TEXT NOT NULL,
    dog TEXT NOT NULL,
    at INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    from_name TEXT,
    peer_name TEXT,
    UNIQUE (chat, id)
  );
  CREATE INDEX IF NOT EXISTS messages_chat_at ON messages(chat, at);
  CREATE INDEX IF NOT EXISTS messages_at ON messages(at);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rid', tokenize='unicode61');
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab('messages_fts', 'row');
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rid, CASE WHEN new.kind = 'activity' THEN NULL ELSE new.text END);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rid, CASE WHEN old.kind = 'activity' THEN NULL ELSE old.text END);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rid, CASE WHEN old.kind = 'activity' THEN NULL ELSE old.text END);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rid, CASE WHEN new.kind = 'activity' THEN NULL ELSE new.text END);
  END;
  CREATE TABLE IF NOT EXISTS memory (
    rid INTEGER PRIMARY KEY,
    dog TEXT NOT NULL,
    path TEXT NOT NULL,
    text TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    UNIQUE (dog, path)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory', content_rowid='rid', tokenize='unicode61');
  CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, text) VALUES (new.rid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rid, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF text ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rid, old.text);
    INSERT INTO memory_fts(rowid, text) VALUES (new.rid, new.text);
  END;
`;

const SUBSTRING_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_tri USING fts5(text, content='messages', content_rowid='rid', tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS messages_tri_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_tri(rowid, text) SELECT new.rid, new.text WHERE new.kind IN ('text', 'activity');
  END;
  CREATE TRIGGER IF NOT EXISTS messages_tri_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_tri(messages_tri, rowid, text) SELECT 'delete', old.rid, old.text WHERE old.kind IN ('text', 'activity');
  END;
  CREATE TRIGGER IF NOT EXISTS messages_tri_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_tri(messages_tri, rowid, text) SELECT 'delete', old.rid, old.text WHERE old.kind IN ('text', 'activity');
    INSERT INTO messages_tri(rowid, text) SELECT new.rid, new.text WHERE new.kind IN ('text', 'activity');
  END;
`;

export const INDEX_REQUEST_ERROR = "index request: ";

function fail(message: string): never {
  throw new Error(`${INDEX_REQUEST_ERROR}${message}`);
}

function identifier(value: unknown, field: string): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : fail(`${field} is not a valid id`);
}

function timestamp(value: unknown, field: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${field} is not a time`);
}

function text(value: unknown, field: string, max = INDEX_TEXT_MAX_CHARS): string {
  return typeof value === "string" ? value.slice(0, max) : fail(`${field} is not text`);
}

function optionalName(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 200) : null;
}

function list<T>(value: unknown, field: string, max = INDEX_FEED_MAX_ITEMS): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) && value.length <= max ? (value as T[]) : fail(`${field} must be a list of at most ${max}`);
}

function limitOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), MAX_LIMIT) : fallback;
}

function scope(value: unknown, field: string): string {
  return JSON.stringify(list<unknown>(value, field, INDEX_SCOPE_MAX).map((item) => identifier(item, field)));
}

function range(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") fail("range is not a range");
  const { since, until } = value as Record<string, unknown>;
  return {
    ...(since === undefined ? {} : { since: timestamp(since, "range.since") }),
    ...(until === undefined ? {} : { until: timestamp(until, "range.until") }),
  };
}

function mode(value: unknown) {
  return value === "any" ? "any" : "all";
}

function folded(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

interface RecallRow {
  chat: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  from_name: string | null;
  peer_name: string | null;
  snippet: string;
}

export interface SearchIndex {
  feed(batch: IndexFeedBatch): { applied: number };
  recall(request: IndexRecallRequest): IndexRecallHit[];
  recent(request: IndexRecentRequest): IndexRecallHit[];
  memory(request: IndexMemoryRequest): IndexMemoryHit[];
  search(request: IndexSearchRequest): IndexSearchHit[];
  has(request: IndexHasRequest): IndexHasAnswer;
  files(request: IndexFilesRequest): IndexMemoryText[];
  stats(): IndexStats;
}

export interface SearchIndexOptions {
  broadMatches?: number;
  substring?: boolean;
}

export function searchIndex(sql: SqlPort, { broadMatches = BROAD_MATCHES, substring = true }: SearchIndexOptions = {}): SearchIndex {
  sql.script(SCHEMA);
  if (substring) sql.script(SUBSTRING_SCHEMA);

  function upsertMessage(raw: IndexMessage) {
    const kind = typeof raw.kind === "string" && KIND.test(raw.kind) ? raw.kind : fail("message kind is not valid");
    sql.all(
      "INSERT INTO messages (chat, id, dog, at, role, kind, text, from_name, peer_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (chat, id) DO UPDATE SET dog = excluded.dog, at = excluded.at, role = excluded.role, kind = excluded.kind, " +
        "text = excluded.text, from_name = excluded.from_name, peer_name = excluded.peer_name " +
        "WHERE messages.text IS NOT excluded.text OR messages.at IS NOT excluded.at OR messages.kind IS NOT excluded.kind " +
        "OR messages.from_name IS NOT excluded.from_name OR messages.peer_name IS NOT excluded.peer_name OR messages.dog IS NOT excluded.dog",
      identifier(raw.chat, "chat"), identifier(raw.id, "id"), identifier(raw.dog, "dog"), timestamp(raw.at, "at"),
      text(raw.role, "role", 32), kind, text(raw.text, "text"), optionalName(raw.from), optionalName(raw.peer),
    );
  }

  function upsertMemory(raw: Record<string, unknown>) {
    sql.all(
      "INSERT INTO memory (dog, path, text, mtime, bytes) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (dog, path) DO UPDATE SET text = excluded.text, mtime = excluded.mtime, bytes = excluded.bytes " +
        "WHERE memory.text IS NOT excluded.text OR memory.mtime IS NOT excluded.mtime",
      identifier(raw.dog, "dog"), text(raw.path, "path", 512), text(raw.text, "memory text"), timestamp(raw.mtime, "mtime"), timestamp(raw.bytes, "bytes"),
    );
  }

  function termMatches(term: string, prefix: boolean): number {
    const parts = term.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!parts.length) return 0;
    return Math.min(...parts.map((part, at) => (prefix && at === parts.length - 1
      ? sql.all<{ n: number | null }>("SELECT sum(doc) AS n FROM messages_vocab WHERE term >= ? AND term < ?", part, `${part}\u{10ffff}`)[0]?.n
      : sql.all<{ n: number }>("SELECT doc AS n FROM messages_vocab WHERE term = ?", part)[0]?.n) ?? 0));
  }

  function boundedMatch(match: string): string | null {
    const terms = [...match.matchAll(/"([^"]*)"(\*?)/g)].map(([whole, term, star]) => ({ whole, matches: termMatches(term, star === "*") }));
    if (match.includes(" OR ")) {
      const kept = terms.filter((term) => term.matches <= broadMatches);
      return kept.length ? kept.map((term) => term.whole).join(" OR ") : null;
    }
    if (terms.length && Math.min(...terms.map((term) => term.matches)) > broadMatches) fail("query is too broad, try a narrower search");
    return match;
  }

  return {
    feed(batch) {
      const messages = list<IndexMessage>(batch.messages, "messages");
      const removeMessages = list<{ chat: unknown; id: unknown }>(batch.removeMessages, "removeMessages");
      const removeChats = list<{ chat: unknown }>(batch.removeChats, "removeChats");
      const memory = list<Record<string, unknown>>(batch.memory, "memory");
      const removeMemory = list<{ dog: unknown; path: unknown }>(batch.removeMemory, "removeMemory");
      const total = messages.length + removeMessages.length + removeChats.length + memory.length + removeMemory.length;
      if (total > INDEX_FEED_MAX_ITEMS) fail(`a feed batch holds at most ${INDEX_FEED_MAX_ITEMS} items`);
      sql.batch(() => {
        for (const item of removeChats) sql.all("DELETE FROM messages WHERE chat = ?", identifier(item.chat, "chat"));
        for (const item of removeMessages) sql.all("DELETE FROM messages WHERE chat = ? AND id = ?", identifier(item.chat, "chat"), identifier(item.id, "id"));
        for (const item of messages) upsertMessage(item);
        for (const item of removeMemory) sql.all("DELETE FROM memory WHERE dog = ? AND path = ?", identifier(item.dog, "dog"), text(item.path, "path", 512));
        for (const item of memory) upsertMemory(item);
      });
      return { applied: total };
    },

    recall(request) {
      const chats = scope(request.chats, "chats");
      const query = ftsQuery(text(request.query, "query", 2_000), mode(request.mode));
      const match = query && chats !== "[]" ? boundedMatch(query) : null;
      if (!match) return [];
      const window = rangeClause(range(request.range), "m.at");
      const rows = sql.all<RecallRow>(
        "SELECT m.chat, m.id, m.at, m.role, m.kind, m.from_name, m.peer_name, " +
          `snippet(messages_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet ` +
          "FROM messages_fts JOIN messages m ON m.rid = messages_fts.rowid " +
          `WHERE messages_fts MATCH ? AND m.kind IN ('text', 'digest') AND m.chat IN (SELECT value FROM json_each(?))${window.sql} ` +
          "ORDER BY (m.kind = 'digest'), bm25(messages_fts), m.at DESC LIMIT ?",
        match, chats, ...window.params, limitOf(request.limit, 12),
      );
      return rows.map((row) => ({
        threadId: row.chat,
        messageId: row.id,
        at: row.at,
        role: row.role,
        ...(row.kind === "digest" ? { kind: "digest" as const } : {}),
        snippet: folded(row.snippet),
        ...(row.from_name ? { from: row.from_name } : {}),
        ...(row.peer_name ? { peer: row.peer_name } : {}),
      }));
    },

    recent(request) {
      const chats = scope(request.chats, "chats");
      if (chats === "[]") return [];
      const window = rangeClause(range(request.range), "m.at");
      const rows = sql.all<Omit<RecallRow, "snippet" | "kind"> & { head: string }>(
        "SELECT m.chat, m.id, m.at, m.role, m.from_name, m.peer_name, substr(m.text, 1, ?) AS head FROM messages m " +
          `WHERE m.kind = 'text' AND m.text != '' AND m.chat IN (SELECT value FROM json_each(?))${window.sql} ORDER BY m.at DESC LIMIT ?`,
        RECENT_HEAD_CHARS, chats, ...window.params, limitOf(request.limit, 12),
      );
      return rows.map((row) => {
        const head = folded(row.head);
        return {
          threadId: row.chat,
          messageId: row.id,
          at: row.at,
          role: row.role,
          snippet: head.length > RECENT_HEAD_CHARS ? `${head.slice(0, RECENT_HEAD_CHARS)}…` : head,
          ...(row.from_name ? { from: row.from_name } : {}),
          ...(row.peer_name ? { peer: row.peer_name } : {}),
        };
      });
    },

    memory(request) {
      const queryMode = mode(request.mode);
      const match = ftsQuery(text(request.query, "query", 2_000), queryMode);
      const dogs = list<unknown>(request.dogs, "dogs", INDEX_SCOPE_MAX).map((dog) => identifier(dog, "dogs"));
      if (!match || !dogs.length) return [];
      const limit = limitOf(request.limit, 12);
      const read = (scope: string[]) => sql.all<{ dog: string; path: string; mtime: number; snippet: string }>(
        "SELECT f.dog, f.path, f.mtime, " +
          `snippet(memory_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet ` +
          "FROM memory_fts JOIN memory f ON f.rid = memory_fts.rowid " +
          "WHERE memory_fts MATCH ? AND f.dog IN (SELECT value FROM json_each(?)) " +
          (queryMode === "any" ? "AND f.path NOT IN ('MEMORY.md', 'memory/archive.md') AND f.path NOT LIKE 'memory/log/%' " : "") +
          "ORDER BY bm25(memory_fts), f.mtime DESC LIMIT ?",
        match, JSON.stringify(scope), limit,
      );
      const rows = request.each ? dogs.flatMap((dog) => read([dog])) : read(dogs);
      return rows.map((row) => ({ dog: row.dog, file: row.path, at: row.mtime, snippet: folded(row.snippet) }));
    },

    search(request) {
      if (!substring) fail("this index has no substring search");
      const needle = text(request.query, "query", 500).trim().toLowerCase();
      if (!needle) return [];
      const chats = request.chats === undefined ? null : scope(request.chats, "chats");
      const scoped = chats ? " AND m.chat IN (SELECT value FROM json_each(?))" : "";
      const limit = limitOf(request.limit, 40);
      const rows = [...needle].length >= 3
        ? sql.all<RecallRow & { text: string }>(
          "SELECT m.chat, m.id, m.at, m.role, m.kind, m.text, m.from_name FROM messages m " +
            "WHERE m.rid IN (SELECT rowid FROM messages_tri WHERE messages_tri MATCH ? ORDER BY rowid DESC LIMIT ?) " +
            `AND m.kind IN ('text', 'activity')${scoped} ORDER BY m.at DESC LIMIT ?`,
          `"${needle.replace(/"/g, '""')}"`, SUBSTRING_CANDIDATES, ...(chats ? [chats] : []), limit,
        )
        : sql.all<RecallRow & { text: string }>(
          "SELECT m.chat, m.id, m.at, m.role, m.kind, m.text, m.from_name FROM messages m " +
            "WHERE m.rid > (SELECT coalesce(max(rid), 0) FROM messages) - ? AND lower(m.text) LIKE ? ESCAPE '\\' " +
            `AND m.kind IN ('text', 'activity')${scoped} ORDER BY m.at DESC LIMIT ?`,
          SHORT_NEEDLE_WINDOW, `%${needle.replace(/([\\%_])/g, "\\$1")}%`, ...(chats ? [chats] : []), limit,
        );
      return rows.map((row) => ({
        threadId: row.chat,
        messageId: row.id,
        at: row.at,
        role: row.role,
        kind: row.kind,
        ...substringSnippet(row.text, needle),
        ...(row.from_name ? { from: row.from_name } : {}),
      }));
    },

    has(request) {
      const messages = list<{ chat: unknown; id: unknown }>(request.messages, "messages").map((item) => [identifier(item.chat, "chat"), identifier(item.id, "id")]);
      const memory = list<{ dog: unknown; path: unknown }>(request.memory, "memory").map((item) => [identifier(item.dog, "dog"), text(item.path, "path", 512)]);
      return {
        messages: messages.flatMap(([chat, id]) => sql.all<{ at: number; kind: string; text: string }>("SELECT at, kind, text FROM messages WHERE chat = ? AND id = ?", chat, id)
          .map((row) => ({ chat, id, at: row.at, kind: row.kind, sum: textSum(row.text) }))),
        memory: memory.flatMap(([dog, path]) => sql.all<{ mtime: number; text: string }>("SELECT mtime, text FROM memory WHERE dog = ? AND path = ?", dog, path)
          .map((row) => ({ dog, path, mtime: row.mtime, sum: textSum(row.text) }))),
      };
    },

    files(request) {
      const dogs = list<unknown>(request.dogs, "dogs", 64).map((dog) => identifier(dog, "dogs"));
      return dogs.flatMap((dog) => sql.all<{ path: string; text: string; mtime: number }>("SELECT path, text, mtime FROM memory WHERE dog = ? ORDER BY path", dog)
        .map((row) => ({ dog, path: row.path, text: row.text, mtime: row.mtime })));
    },

    stats() {
      const [counts] = sql.all<{ messages: number }>("SELECT count(*) AS messages FROM messages");
      const [memory] = sql.all<{ files: number }>("SELECT count(*) AS files FROM memory");
      return { messages: counts.messages, memoryFiles: memory.files, bytes: sql.size() };
    },
  };
}
