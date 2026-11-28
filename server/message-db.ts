import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { peerProvenanceAuthor } from "./peer-provenance.ts";
import type { ResolvedSender, SteerQueueReason } from "../shared/wire.ts";
import type { Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";
import { ReplyDiskReserve } from "./laterdog/reply-disk-reserve.ts";
import { rollbackQuietly } from "./laterdog/safe-rollback.ts";
import { ensureNativeRuns, deleteNativeRuns } from "./laterdog/native-run-store.ts";
import { MessageSearchWorker, WITHIN_BUDGET, type ReadQuery } from "./message-search-worker.ts";
import { searchMessagesInDatabase, type SearchHit } from "./message-search-query.ts";
import { ftsQuery, rangeClause, type RecallRange, type SearchMode } from "../shared/search-index-query.ts";
export { recallMatchTerm, recallTerms, type RecallRange, type SearchMode } from "../shared/search-index-query.ts";
export type { SearchHit } from "./message-search-query.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

const replyReserve = new ReplyDiskReserve();
let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let searchWorker: MessageSearchWorker | null = null;
let recallWorker: MessageSearchWorker | null = null;
let indexWorker: MessageSearchWorker | null = null;

export interface MessageWrites {
  message(threadId: string, id: string): void;
  chat(threadId: string): void;
  memory(botId: string, path: string): void;
}

let writes: MessageWrites | null = null;

export function watchMessageWrites(next: MessageWrites | null): void {
  writes = next;
}
let closingSearch: Promise<void> = Promise.resolve();

function open(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = DB_FILE();
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS messages_cards ON messages(thread_id) WHERE kind = 'options';
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_followups (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      send_id TEXT,
      status TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_followups_receipt ON chat_followups(kind, owner_id, thread_id, send_id);
    CREATE TABLE IF NOT EXISTS search_index_outbox (
      kind TEXT NOT NULL,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      PRIMARY KEY (kind, a, b)
    );
    CREATE TABLE IF NOT EXISTS search_index_coverage (
      home TEXT NOT NULL,
      chat TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (home, chat, target)
    );
    CREATE TABLE IF NOT EXISTS command_receipts (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      at INTEGER NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    );
  `);
  ensureRecallIndex(db);
  ensureMemoryIndex(db);
  ensureNativeRuns(db);
  return db;
}

function ensureMemoryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      bot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      text TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (bot_id, path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text, content='memory_files', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_files BEGIN
      INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_files BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_files BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
}

export function describeMissingFts5(error: unknown): Error | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/no such module:\s*fts5/i.test(message)) return null;
  return new Error(
    `later.dog needs SQLite with FTS5, which is built into Node 24 and newer (and into the app). ` +
    `This Node (${process.version}) has none: install Node 24 or newer. (${message})`,
  );
}

function ensureRecallIndex(db: DatabaseSync): void {
  const existed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, content='messages', content_rowid='rowid', tokenize='unicode61'
      );
    `);
  } catch (error) {
    throw describeMissingFts5(error) ?? error;
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  if (!existed) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

const UPSERT_MESSAGE =
  "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(thread_id, id) DO UPDATE SET at = excluded.at, role = excluded.role, kind = excluded.kind, " +
  "text = excluded.text, json = excluded.json";

function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  replyReserve.close();
  handle = open();
  replyReserve.prepare(DATA_DIR);
  handlePath = DB_FILE();
  return handle;
}

let transactionDepth = 0;
function transaction<T>(fn: (database: DatabaseSync) => T): T {
  const database = db();
  if (transactionDepth > 0) {
    const savepoint = `command_${transactionDepth}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    transactionDepth += 1;
    try {
      const result = fn(database);
      database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      rollbackQuietly(database, `ROLLBACK TO ${savepoint}`);
      rollbackQuietly(database, `RELEASE ${savepoint}`);
      throw error;
    } finally { transactionDepth -= 1; }
  }
  database.exec("BEGIN IMMEDIATE");
  transactionDepth = 1;
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    transactionDepth = 0;
  }
}

export interface FollowupPayload {
  text: string;
  prompt?: string;
  replyToId?: string;
  sendId?: string;
  reason?: SteerQueueReason;
  unattended?: boolean;
  peerAsk?: Message["peerAsk"];
  via?: "api" | "call";
  sender?: ResolvedSender;
  trigger?: UsageTrigger;
  queuedAt?: number;
  aside?: {
    fromBotId: string;
    fromBotName: string;
    unattended?: boolean;
    commsDepth: number;
  };
}
export type FollowupStatus = "pending" | "dispatching" | "interrupted" | "cancelled";
export interface ChatFollowup {
  id: string;
  kind: "bot" | "channel" | "aside";
  ownerId: string;
  threadId: string;
  status: FollowupStatus;
  payload: FollowupPayload;
}

function writeFollowups(write: (connection: DatabaseSync) => void): void {
  const connection = db();
  connection.exec("PRAGMA synchronous = FULL");
  try {
    connection.exec("BEGIN IMMEDIATE");
    try { write(connection); connection.exec("COMMIT"); }
    catch (error) { rollbackQuietly(connection); throw error; }
  } finally { connection.exec("PRAGMA synchronous = NORMAL"); }
}

export interface StoredCommandReceipt {
  kind: string;
  key: string;
  at: number;
  result: string;
}

export function readCommandReceipt(kind: string, key: string): StoredCommandReceipt | null {
  const row = db()
    .prepare("SELECT kind, key, at, result FROM command_receipts WHERE kind = ? AND key = ?")
    .get(kind, key) as StoredCommandReceipt | undefined;
  return row ?? null;
}

export function withCommandReceipt(
  kind: string,
  key: string,
  apply: () => string,
  at: number,
): { result: string; replayed: boolean } {
  return transaction((database) => {
    const existing = database
      .prepare("SELECT result FROM command_receipts WHERE kind = ? AND key = ?")
      .get(kind, key) as { result: string } | undefined;
    if (existing) return { result: existing.result, replayed: true };
    const result = apply();
    database
      .prepare("INSERT INTO command_receipts(kind, key, at, result) VALUES (?, ?, ?, ?)")
      .run(kind, key, at, result);
    return { result, replayed: false };
  });
}

export function saveChatFollowup(followup: Omit<ChatFollowup, "status">): void {
  writeFollowups((connection) => connection.prepare(
    "INSERT INTO chat_followups(id, kind, owner_id, thread_id, send_id, status, payload) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  ).run(followup.id, followup.kind, followup.ownerId, followup.threadId, followup.payload.sendId ?? null, JSON.stringify(followup.payload)));
}

export function settleChatFollowups(ids: string[], status: FollowupStatus | null): void {
  if (!ids.length) return;
  writeFollowups((connection) => {
    const statement = connection.prepare(status === null
      ? "DELETE FROM chat_followups WHERE id = ?"
      : status === "cancelled"
        ? "UPDATE chat_followups SET status = ?, payload = '{\"text\":\"\"}' WHERE id = ?"
        : "UPDATE chat_followups SET status = ? WHERE id = ?");
    for (const id of ids) {
      if (status === null) statement.run(id);
      else statement.run(status, id);
    }
  });
}

export function chatFollowups(kind?: ChatFollowup["kind"]): ChatFollowup[] {
  const rows = (kind
    ? db().prepare("SELECT * FROM chat_followups WHERE kind = ? ORDER BY rowid").all(kind)
    : db().prepare("SELECT * FROM chat_followups ORDER BY rowid").all()) as Array<{
      id: string; kind: ChatFollowup["kind"]; owner_id: string; thread_id: string; status: FollowupStatus; payload: string;
    }>;
  return rows.map((row) => ({ id: row.id, kind: row.kind, ownerId: row.owner_id, threadId: row.thread_id,
    status: row.status, payload: JSON.parse(row.payload) as FollowupPayload }));
}

export function cancelledChatFollowup(kind: ChatFollowup["kind"], ownerId: string, threadId: string, sendId: string): boolean {
  return Boolean(db().prepare(
    "SELECT 1 FROM chat_followups WHERE kind = ? AND owner_id = ? AND thread_id = ? AND send_id = ? AND status = 'cancelled'",
  ).get(kind, ownerId, threadId, sendId));
}

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

export interface ThreadTailRows extends ThreadRows {
  hasMore?: boolean;
}

export function hasPendingRequest(threadId: string, legacyFile: string): boolean {
  const database = db();
  const pending = database.prepare(
    "SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' " +
    "AND json_extract(json, '$.requestPending') = 1 AND json_extract(json, '$.requestCancelled') IS NOT 1 LIMIT 1",
  ).get(threadId);
  if (pending) return true;
  const known = database.prepare("SELECT 1 FROM thread_state WHERE thread_id = ?").get(threadId)
    || database.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId);
  return !known && existsSync(legacyFile);
}

export function readThreadTail(threadId: string, legacyFile: string, limit: number): ThreadTailRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, limit + 1) as Array<{ json: string }>;
  if (rows.length) {
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    rows.reverse();
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null, hasMore };
  }
  return importLegacy(threadId, legacyFile);
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId };
  }
  if (Array.isArray(raw)) messages = raw as Message[];
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(UPSERT_MESSAGE);
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db());
    throw error;
  }
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare(UPSERT_MESSAGE)
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  writes?.message(threadId, message.id);
}

export function importThread(threadId: string, messages: Message[], activeLeafId: string | null): void {
  transaction((database) => {
    if (database.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId) ||
        database.prepare("SELECT 1 FROM thread_state WHERE thread_id = ?").get(threadId)) {
      throw new Error("Cannot import over an existing conversation");
    }
    for (const message of messages) insertMessage(threadId, message);
    setActiveLeaf(threadId, activeLeafId);
  });
}

function writeMessage(message: Message, write: () => void): void {
  if (message.role === "bot" && message.kind === "text") replyReserve.save(write);
  else write();
}

export function appendMessage(threadId: string, message: Message): void {
  writeMessage(message, () => transaction(() => {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
  }));
  if (message.role === "user") replyReserve.prepare(DATA_DIR);
}

export function updateMessage(threadId: string, message: Message): void {
  writeMessage(message, () => db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id));
  writes?.message(threadId, message.id);
}

export function readMessagesJson(threadId: string, ids: readonly string[]): Array<{ id: string; at: number; json: string }> {
  const statement = db().prepare("SELECT id, at, json FROM messages WHERE thread_id = ? AND id = ?");
  const rows: Array<{ id: string; at: number; json: string }> = [];
  for (const id of ids) {
    const row = statement.get(threadId, id) as { id: string; at: number; json: string } | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

export function openPermissionCards(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      "WHERE kind = 'options' AND json_extract(json, '$.card.requestType') = 'permission' " +
      "AND json_extract(json, '$.card.answered') IS NULL " +
      "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 " +
      "AND COALESCE(json_extract(json, '$.card.expired'), 0) = 0",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

export function openRequestCards(tools: readonly string[]): Array<{ threadId: string; message: Message }> {
  if (!tools.length) return [];
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      `WHERE kind = 'options' AND json_extract(json, '$.card.tool') IN (${tools.map(() => "?").join(", ")}) ` +
      "AND COALESCE(json_extract(json, '$.card.requestId'), '') <> '' " +
      "AND json_extract(json, '$.card.answered') IS NULL " +
      "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0",
    )
    .all(...tools) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

export function questionCardsCountingDown(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      "WHERE kind = 'options' AND json_extract(json, '$.card.autoAnswerAt') IS NOT NULL",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function latestMessageAts(threadIds: readonly string[]): Map<string, number> {
  return latestAtsWhere(threadIds, "");
}

export function latestPersonMessageAts(threadIds: readonly string[]): Map<string, number> {
  return latestAtsWhere(threadIds, "AND role = 'user' AND kind = 'text' AND json_extract(json, '$.peerAsk') IS NULL");
}

function latestAtsWhere(threadIds: readonly string[], condition: string): Map<string, number> {
  const ids = [...new Set(threadIds.filter((id) => id.length > 0))];
  const out = new Map<string, number>();
  const chunk = 400;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(", ");
    const rows = db()
      .prepare(`SELECT thread_id, MAX(at) AS at FROM messages WHERE thread_id IN (${placeholders}) ${condition} GROUP BY thread_id`)
      .all(...slice) as Array<{ thread_id: string; at: number }>;
    for (const row of rows) {
      if (typeof row.at === "number" && Number.isFinite(row.at)) out.set(row.thread_id, row.at);
    }
  }
  return out;
}

export function deleteThread(threadId: string): void {
  writeFollowups((connection) => {
    deleteNativeRuns(connection, threadId);
    connection.prepare("DELETE FROM chat_followups WHERE thread_id = ?").run(threadId);
    connection.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    connection.prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
  });
  writes?.chat(threadId);
}

export const nativeRunDatabase = {
  read: <T>(read: (database: DatabaseSync) => T): T => read(db()),
  write: <T>(write: (database: DatabaseSync) => T): T => transaction(write),
};

export function threadsReferencing(fragment: string): string[] {
  if (!fragment) return [];
  const rows = db().prepare("SELECT DISTINCT thread_id FROM messages WHERE instr(json, ?) > 0").all(fragment) as Array<{ thread_id: string }>;
  return rows.map((row) => row.thread_id);
}

export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  return searchMessagesInDatabase(db(), query, limit, threadId);
}

export function searchMessagesAsync(query: string, limit = 40, threadId?: string): Promise<SearchHit[]> {
  if (!query.trim()) return Promise.resolve([]);
  db();
  searchWorker ??= new MessageSearchWorker(DB_FILE());
  return searchWorker.search(query, limit, threadId);
}

export interface RecallHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind?: "digest";
  snippet: string;
  from?: string;
  peer?: string;
}

function peerAuthor(peerName: string | null, text: string): string | null {
  return peerName ?? peerProvenanceAuthor(text);
}

const PEER_NOTE_HEAD_CHARS = 160;

const SNIPPET_TOKENS = 48;

export function readMessageText(
  threadId: string,
  messageId: string,
): { threadId: string; messageId: string; at: number; role: string; text: string; from?: string; peer?: string } | null {
  const row = db()
    .prepare(
      "SELECT at, role, text, json_extract(json, '$.from.name') AS from_name, " +
        "json_extract(json, '$.peerAsk.name') AS peer_name FROM messages " +
        "WHERE thread_id = ? AND id = ? AND kind = 'text' AND text IS NOT NULL",
    )
    .get(threadId, messageId) as
    | { at: number; role: string; text: string; from_name: string | null; peer_name: string | null }
    | undefined;
  if (!row) return null;
  const peer = peerAuthor(row.peer_name, row.text);
  return {
    threadId,
    messageId,
    at: row.at,
    role: row.role,
    text: row.text,
    ...(row.from_name ? { from: row.from_name } : {}),
    ...(peer ? { peer } : {}),
  };
}

type RecallRow = {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  from_name: string | null;
  peer_name: string | null;
  head: string;
  snippet: string;
};

function recallRead(query: string, threadIds: readonly string[], limit: number, range: RecallRange | undefined, mode: SearchMode, guard = ""): ReadQuery | null {
  const match = ftsQuery(query, mode);
  if (!match || !threadIds.length) return null;
  const placeholders = threadIds.map(() => "?").join(", ");
  const window = rangeClause(range, "m.at");
  return {
    sql:
      "SELECT m.thread_id, m.id, m.at, m.role, m.kind, json_extract(m.json, '$.from.name') AS from_name, " +
      `json_extract(m.json, '$.peerAsk.name') AS peer_name, substr(m.text, 1, ${PEER_NOTE_HEAD_CHARS}) AS head, ` +
      `snippet(messages_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet ` +
      "FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid " +
      `WHERE messages_fts MATCH ? AND m.kind IN ('text', 'digest') AND m.thread_id IN (${placeholders})${window.sql}${guard} ` +
      "ORDER BY (m.kind = 'digest'), bm25(messages_fts), m.at DESC LIMIT ?",
    params: [match, ...threadIds, ...window.params, limit],
  };
}

function recallHits(rows: RecallRow[]): RecallHit[] {
  return rows.map((row) => {
    const peer = peerAuthor(row.peer_name, row.head);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      ...(row.kind === "digest" ? { kind: "digest" as const } : {}),
      snippet: row.snippet.replace(/\s+/g, " ").trim(),
      ...(row.from_name ? { from: row.from_name } : {}),
      ...(peer ? { peer } : {}),
    };
  });
}

function readHere<T>(read: ReadQuery | null): T[] {
  return read ? db().prepare(read.sql).all(...read.params) as T[] : [];
}

export const RECALL_BUDGET_MS = 3_000;

async function readOffThread<T>(read: ReadQuery | null): Promise<T[]> {
  if (!read) return [];
  return (await readAllOffThread([read]))[0] as T[];
}

function readAllOffThread(reads: ReadQuery[]): Promise<unknown[][]> {
  if (!reads.length) return Promise.resolve([]);
  db();
  recallWorker ??= new MessageSearchWorker(DB_FILE(), RECALL_BUDGET_MS);
  return recallWorker.read(reads);
}

export function recallMessages(query: string, threadIds: readonly string[], limit = 12, range?: RecallRange, mode: SearchMode = "all"): RecallHit[] {
  return recallHits(readHere<RecallRow>(recallRead(query, threadIds, limit, range, mode)));
}

export async function recallMessagesOffThread(query: string, threadIds: readonly string[], limit = 12, range?: RecallRange, mode: SearchMode = "all"): Promise<RecallHit[]> {
  return recallHits(await readOffThread<RecallRow>(recallRead(query, threadIds, limit, range, mode, WITHIN_BUDGET)));
}

const RECENT_HEAD_CHARS = 240;

type RecentRow = { thread_id: string; id: string; at: number; role: string; from_name: string | null; peer_name: string | null; head: string };

function recentRead(threadIds: readonly string[], range: RecallRange, limit: number, guard = ""): ReadQuery | null {
  if (!threadIds.length) return null;
  const placeholders = threadIds.map(() => "?").join(", ");
  const window = rangeClause(range, "m.at");
  return {
    sql:
      "SELECT m.thread_id, m.id, m.at, m.role, json_extract(m.json, '$.from.name') AS from_name, " +
      `json_extract(m.json, '$.peerAsk.name') AS peer_name, substr(m.text, 1, ${Math.max(PEER_NOTE_HEAD_CHARS, RECENT_HEAD_CHARS)}) AS head ` +
      `FROM messages m WHERE m.kind = 'text' AND m.text IS NOT NULL AND m.thread_id IN (${placeholders})${window.sql}${guard} ` +
      "ORDER BY m.at DESC LIMIT ?",
    params: [...threadIds, ...window.params, limit],
  };
}

function recentHits(rows: RecentRow[]): RecallHit[] {
  return rows.map((row) => {
    const peer = peerAuthor(row.peer_name, row.head);
    const folded = row.head.replace(/\s+/g, " ").trim();
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      snippet: folded.length > RECENT_HEAD_CHARS ? `${folded.slice(0, RECENT_HEAD_CHARS)}…` : folded,
      ...(row.from_name ? { from: row.from_name } : {}),
      ...(peer ? { peer } : {}),
    };
  });
}

export function recentMessages(threadIds: readonly string[], range: RecallRange, limit = 12): RecallHit[] {
  return recentHits(readHere<RecentRow>(recentRead(threadIds, range, limit)));
}

export async function recentMessagesOffThread(threadIds: readonly string[], range: RecallRange, limit = 12): Promise<RecallHit[]> {
  return recentHits(await readOffThread<RecentRow>(recentRead(threadIds, range, limit, WITHIN_BUDGET)));
}

export interface ThreadLatest {
  threadId: string;
  messageId: string;
  at: number;
  head: string;
}

export function latestSaidByBot(threadIds: readonly string[], botId: string, since: number, limit = 20): ThreadLatest[] {
  if (!threadIds.length) return [];
  const placeholders = threadIds.map(() => "?").join(", ");
  const rows = db()
    .prepare(
      "SELECT thread_id, id, at, head FROM (" +
        "SELECT m.thread_id, m.id, m.at, substr(m.text, 1, 400) AS head, " +
        "ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.at DESC) AS rn " +
        "FROM messages m " +
        `WHERE m.kind = 'text' AND m.role = 'bot' AND m.text IS NOT NULL AND m.at >= ? AND m.thread_id IN (${placeholders}) ` +
        "AND (json_extract(m.json, '$.from.botId') IS NULL OR json_extract(m.json, '$.from.botId') = ?)" +
        ") WHERE rn = 1 ORDER BY at DESC LIMIT ?",
    )
    .all(since, ...threadIds, botId, limit) as Array<{ thread_id: string; id: string; at: number; head: string }>;
  return rows.map((row) => ({
    threadId: row.thread_id,
    messageId: row.id,
    at: row.at,
    head: row.head.replace(/\s+/g, " ").trim(),
  }));
}

export interface MemoryFileStat {
  path: string;
  mtimeMs: number;
  bytes: number;
}

export function indexMemoryFile(botId: string, path: string, text: string, stat: { mtimeMs: number; bytes: number }): void {
  db()
    .prepare(
      "INSERT INTO memory_files (bot_id, path, text, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(bot_id, path) DO UPDATE SET text = excluded.text, mtime_ms = excluded.mtime_ms, bytes = excluded.bytes",
    )
    .run(botId, path, text, Math.trunc(stat.mtimeMs), stat.bytes);
  writes?.memory(botId, path);
}

export function removeMemoryFile(botId: string, path: string): void {
  db().prepare("DELETE FROM memory_files WHERE bot_id = ? AND path = ?").run(botId, path);
  writes?.memory(botId, path);
}

export function readForIndex(reads: ReadQuery[]): Promise<unknown[][]> {
  if (!reads.length) return Promise.resolve([]);
  db();
  indexWorker ??= new MessageSearchWorker(DB_FILE(), 10_000);
  return indexWorker.read(reads);
}

export type IndexOutboxKey = { kind: "message"; chat: string; id: string } | { kind: "chat"; chat: string } | { kind: "memory"; dog: string; path: string };

function outboxRow(key: IndexOutboxKey): [string, string, string] {
  if (key.kind === "message") return ["m", key.chat, key.id];
  if (key.kind === "chat") return ["c", key.chat, ""];
  return ["f", key.dog, key.path];
}

export const indexOutbox = {
  put: (key: IndexOutboxKey): void => void db().prepare("INSERT OR IGNORE INTO search_index_outbox (kind, a, b) VALUES (?, ?, ?)").run(...outboxRow(key)),
  all: (): IndexOutboxKey[] => (db().prepare("SELECT kind, a, b FROM search_index_outbox").all() as Array<{ kind: string; a: string; b: string }>)
    .map((row) => row.kind === "m" ? { kind: "message" as const, chat: row.a, id: row.b } : row.kind === "c" ? { kind: "chat" as const, chat: row.a } : { kind: "memory" as const, dog: row.a, path: row.b }),
  remove: (keys: readonly IndexOutboxKey[]): void => {
    if (!keys.length) return;
    transaction((database) => {
      const remove = database.prepare("DELETE FROM search_index_outbox WHERE kind = ? AND a = ? AND b = ?");
      for (const key of keys) remove.run(...outboxRow(key));
    });
  },
  clear: (): void => void db().prepare("DELETE FROM search_index_outbox").run(),
};

export const indexCoverageTable = {
  read: (home: string): Array<{ chat: string; target: string }> =>
    db().prepare("SELECT chat, target FROM search_index_coverage WHERE home = ?").all(home) as Array<{ chat: string; target: string }>,
  add: (home: string, chat: string, targets: readonly string[]): void => transaction((database) => {
    const insert = database.prepare("INSERT OR IGNORE INTO search_index_coverage (home, chat, target) VALUES (?, ?, ?)");
    for (const target of targets) insert.run(home, chat, target);
  }),
  drop: (home: string, chat: string): void => void db().prepare("DELETE FROM search_index_coverage WHERE home = ? AND chat = ?").run(home, chat),
  clear: (home: string): void => void db().prepare("DELETE FROM search_index_coverage WHERE home = ?").run(home),
};

export function indexedMemoryFiles(botId: string): MemoryFileStat[] {
  const rows = db()
    .prepare("SELECT path, mtime_ms, bytes FROM memory_files WHERE bot_id = ?")
    .all(botId) as Array<{ path: string; mtime_ms: number; bytes: number }>;
  return rows.map((row) => ({ path: row.path, mtimeMs: row.mtime_ms, bytes: row.bytes }));
}

export interface MemoryHit {
  file: string;
  snippet: string;
  at: number;
}

type MemoryRow = { path: string; mtime_ms: number; snippet: string };

function memoryRead(query: string, botId: string, limit: number, mode: SearchMode, guard = ""): ReadQuery | null {
  const match = ftsQuery(query, mode);
  if (!match) return null;
  return {
    sql:
      "SELECT f.path, f.mtime_ms, " +
      `snippet(memory_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet ` +
      "FROM memory_fts JOIN memory_files f ON f.rowid = memory_fts.rowid " +
      `WHERE memory_fts MATCH ? AND f.bot_id = ?${guard} ` +
      (mode === "any" ? "AND f.path NOT IN ('MEMORY.md', 'memory/archive.md') AND f.path NOT LIKE 'memory/log/%' " : "") +
      "ORDER BY bm25(memory_fts), f.mtime_ms DESC LIMIT ?",
    params: [match, botId, limit],
  };
}

function memoryHits(rows: MemoryRow[]): MemoryHit[] {
  return rows.map((row) => ({ file: row.path, at: row.mtime_ms, snippet: row.snippet.replace(/\s+/g, " ").trim() }));
}

export function recallMemory(query: string, botId: string, limit = 12, mode: SearchMode = "all"): MemoryHit[] {
  return memoryHits(readHere<MemoryRow>(memoryRead(query, botId, limit, mode)));
}

export async function recallMemoryOffThread(query: string, botIds: readonly string[], limit = 12, mode: SearchMode = "all"): Promise<MemoryHit[][]> {
  const reads = botIds.map((botId) => memoryRead(query, botId, limit, mode, WITHIN_BUDGET));
  if (reads.some((read) => !read)) return botIds.map(() => []);
  return (await readAllOffThread(reads as ReadQuery[])).map((rows) => memoryHits(rows as MemoryRow[]));
}

export async function closeMessageSearch(): Promise<void> {
  const workers = [searchWorker, recallWorker, indexWorker].filter((worker) => worker !== null);
  searchWorker = null;
  recallWorker = null;
  indexWorker = null;
  if (workers.length) closingSearch = Promise.all([closingSearch, ...workers.map((worker) => worker.close())]).then(() => {});
  await closingSearch;
}

export function closeMessageDb(): void {
  replyReserve.close();
  void closeMessageSearch();
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}

export const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024;

export function reclaimFreePages(diskFreeBytes: number, minFree = VACUUM_MIN_FREE_BYTES): number {
  const database = db();
  const pageSize = Number((database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  const pages = Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  const free = Number((database.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
  const reclaimable = free * pageSize;
  if (reclaimable < minFree || diskFreeBytes < pages * pageSize) return 0;
  database.exec("VACUUM");
  return reclaimable;
}
