import type { DatabaseSync } from "node:sqlite";

export interface OutboxMessage {
  id: string;
  v: number;
  rowid: number | null;
  at: number;
  json: string | null;
}

export interface OutboxChat {
  threadId: string;
  messages: OutboxMessage[];
  chat: { v: number; cleared: boolean; leaf: string | null } | null;
}

export interface LocalHistoryStats {
  count: number;
  bytes: number;
  leaf: string | null;
}

export interface LocalHistoryRow {
  rowid: number;
  id: string;
  at: number;
  json: string;
}

export function ensureHistoryOutbox(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS history_outbox (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      v INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (thread_id, id)
    );
    CREATE TABLE IF NOT EXISTS history_outbox_chats (
      thread_id TEXT PRIMARY KEY,
      v INTEGER NOT NULL DEFAULT 1,
      cleared INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS history_coverage (
      thread_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
  `);
}

export function noteHistoryMessage(database: DatabaseSync, threadId: string, id: string): void {
  database.prepare("INSERT INTO history_outbox (thread_id, id) VALUES (?, ?) ON CONFLICT(thread_id, id) DO UPDATE SET v = v + 1").run(threadId, id);
}

export function noteHistoryChat(database: DatabaseSync, threadId: string, cleared: boolean): void {
  if (cleared) database.prepare("DELETE FROM history_outbox WHERE thread_id = ?").run(threadId);
  database.prepare(
    "INSERT INTO history_outbox_chats (thread_id, cleared) VALUES (?, ?) " +
    "ON CONFLICT(thread_id) DO UPDATE SET v = v + 1, cleared = MAX(cleared, excluded.cleared)",
  ).run(threadId, cleared ? 1 : 0);
  if (cleared) database.prepare("DELETE FROM history_coverage WHERE thread_id = ?").run(threadId);
}

export function outboxSize(database: DatabaseSync): number {
  const row = database.prepare("SELECT (SELECT COUNT(*) FROM history_outbox) + (SELECT COUNT(*) FROM history_outbox_chats) AS n").get() as { n: number };
  return Number(row.n);
}

export function takeOutbox(database: DatabaseSync, maxChats: number, maxMessages: number, skip: ReadonlySet<string>): OutboxChat[] {
  const chats = new Map<string, OutboxChat>();
  const chatOf = (threadId: string) => chats.get(threadId) ?? chats.set(threadId, { threadId, messages: [], chat: null }).get(threadId)!;
  const chatRows = database.prepare("SELECT thread_id, v, cleared FROM history_outbox_chats LIMIT ?").all(maxChats * 4) as Array<{ thread_id: string; v: number; cleared: number }>;
  for (const row of chatRows) {
    if (skip.has(row.thread_id) || (chats.size >= maxChats && !chats.has(row.thread_id))) continue;
    const leaf = database.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(row.thread_id) as { active_leaf_id: string | null } | undefined;
    chatOf(row.thread_id).chat = { v: Number(row.v), cleared: row.cleared === 1, leaf: leaf?.active_leaf_id ?? null };
  }
  const threads = database.prepare("SELECT DISTINCT thread_id FROM history_outbox LIMIT ?").all(maxChats * 4) as Array<{ thread_id: string }>;
  const pending = database.prepare(
    "SELECT o.id, o.v, m.rowid AS rowid, m.at, m.json FROM history_outbox o LEFT JOIN messages m ON m.thread_id = o.thread_id AND m.id = o.id " +
    "WHERE o.thread_id = ? ORDER BY m.rowid IS NULL, m.rowid LIMIT ?",
  );
  for (const { thread_id: threadId } of threads) {
    if (skip.has(threadId) || (chats.size >= maxChats && !chats.has(threadId))) continue;
    const rows = pending.all(threadId, maxMessages) as Array<{ id: string; v: number; rowid: number | null; at: number | null; json: string | null }>;
    chatOf(threadId).messages = rows.map((row) => ({ id: row.id, v: Number(row.v), rowid: row.rowid, at: Number(row.at ?? 0), json: row.json }));
  }
  return [...chats.values()];
}

export function settleOutbox(database: DatabaseSync, chat: OutboxChat): void {
  const drop = database.prepare("DELETE FROM history_outbox WHERE thread_id = ? AND id = ? AND v = ?");
  for (const message of chat.messages) drop.run(chat.threadId, message.id, message.v);
  if (chat.chat) {
    database.prepare("DELETE FROM history_outbox_chats WHERE thread_id = ? AND v = ?").run(chat.threadId, chat.chat.v);
    if (!chat.chat.cleared) return;
    const reborn = database.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(chat.threadId);
    if (reborn) {
      const ids = database.prepare("SELECT id FROM messages WHERE thread_id = ?").all(chat.threadId) as Array<{ id: string }>;
      for (const { id } of ids) noteHistoryMessage(database, chat.threadId, id);
    }
  }
}

export function localHistoryStats(database: DatabaseSync, threadId: string): LocalHistoryStats {
  const row = database.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM messages WHERE thread_id = ?").get(threadId) as { n: number; bytes: number };
  const leaf = database.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId) as { active_leaf_id: string | null } | undefined;
  return { count: Number(row.n), bytes: Number(row.bytes), leaf: leaf?.active_leaf_id ?? null };
}

export function localHistoryPage(database: DatabaseSync, threadId: string, afterRowid: number, limit: number): LocalHistoryRow[] {
  return (database.prepare("SELECT rowid, id, at, json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?")
    .all(threadId, afterRowid, limit) as Array<{ rowid: number; id: string; at: number; json: string }>)
    .map((row) => ({ rowid: Number(row.rowid), id: row.id, at: Number(row.at), json: row.json }));
}

export function localHistoryThreads(database: DatabaseSync): string[] {
  return (database.prepare("SELECT thread_id FROM thread_state UNION SELECT DISTINCT thread_id FROM messages").all() as Array<{ thread_id: string }>)
    .map((row) => row.thread_id);
}

export function chatsAwaitingClear(database: DatabaseSync): Set<string> {
  return new Set((database.prepare("SELECT thread_id FROM history_outbox_chats WHERE cleared = 1").all() as Array<{ thread_id: string }>).map((row) => row.thread_id));
}

export function coveredHistory(database: DatabaseSync): Map<string, { count: number; bytes: number }> {
  const rows = database.prepare("SELECT thread_id, count, bytes FROM history_coverage").all() as Array<{ thread_id: string; count: number; bytes: number }>;
  return new Map(rows.map((row) => [row.thread_id, { count: Number(row.count), bytes: Number(row.bytes) }]));
}

export function isCovered(database: DatabaseSync, threadId: string): boolean {
  return database.prepare("SELECT 1 FROM history_coverage WHERE thread_id = ?").get(threadId) !== undefined;
}

export function markCovered(database: DatabaseSync, threadId: string, stats: { count: number; bytes: number }, at: number): void {
  database.prepare("INSERT INTO history_coverage (thread_id, count, bytes, at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET count = excluded.count, bytes = excluded.bytes, at = excluded.at")
    .run(threadId, stats.count, stats.bytes, at);
}

export function fillFromObject(database: DatabaseSync, threadId: string, rows: ReadonlyArray<{ id: string; at: number; json: string }>, leaf: string | null): { added: number; replaced: number } {
  const have = database.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?");
  const pending = database.prepare("SELECT 1 FROM history_outbox WHERE thread_id = ? AND id = ?");
  const replace = database.prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?");
  const missing: Array<{ id: string; at: number; json: string }> = [];
  let replaced = 0;
  for (const row of rows) {
    const local = have.get(threadId, row.id) as { json: string } | undefined;
    if (!local) missing.push(row);
    else if (local.json !== row.json && !pending.get(threadId, row.id)) {
      const message = parsed(row.json);
      replace.run(row.at, message.role, message.kind, message.text, row.json, threadId, row.id);
      replaced += 1;
    }
  }
  const floor = database.prepare("SELECT MIN(rowid) AS low FROM messages").get() as { low: number | null };
  const firstLocal = database.prepare("SELECT MIN(rowid) AS low FROM messages WHERE thread_id = ?").get(threadId) as { low: number | null };
  const insert = database.prepare("INSERT INTO messages (rowid, thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const append = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let next = Math.min(Number(floor.low ?? 1), 1) - missing.length - 1;
  for (const row of missing) {
    const message = parsed(row.json);
    const values = [threadId, row.id, row.at, message.role, message.kind, message.text, row.json] as const;
    if (firstLocal.low === null) append.run(...values);
    else insert.run(next++, ...values);
  }
  const known = database.prepare("SELECT 1 FROM thread_state WHERE thread_id = ?").get(threadId);
  if (!known && leaf !== null) {
    database.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)").run(threadId, leaf);
  }
  return { added: missing.length, replaced };
}

export function localOnlyRows(database: DatabaseSync, threadId: string, objectIds: ReadonlySet<string>): LocalHistoryRow[] {
  return (database.prepare("SELECT rowid, id, at, json FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId) as Array<{ rowid: number; id: string; at: number; json: string }>)
    .filter((row) => !objectIds.has(row.id))
    .map((row) => ({ rowid: Number(row.rowid), id: row.id, at: Number(row.at), json: row.json }));
}

function parsed(json: string): { role: string; kind: string; text: string | null } {
  const message = JSON.parse(json) as { role?: unknown; kind?: unknown; text?: unknown };
  return {
    role: typeof message.role === "string" ? message.role : "bot",
    kind: typeof message.kind === "string" ? message.kind : "text",
    text: typeof message.text === "string" ? message.text : null,
  };
}

export function clearCoverageOutside(database: DatabaseSync, covers: (threadId: string) => boolean): number {
  const rows = database.prepare("SELECT thread_id FROM history_coverage").all() as Array<{ thread_id: string }>;
  const drop = database.prepare("DELETE FROM history_coverage WHERE thread_id = ?");
  let dropped = 0;
  for (const { thread_id: threadId } of rows) {
    if (covers(threadId)) continue;
    drop.run(threadId);
    dropped += 1;
  }
  return dropped;
}
