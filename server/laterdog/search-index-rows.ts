import type { SQLInputValue } from "node:sqlite";
import { INDEX_TEXT_MAX_CHARS, type IndexMemoryFile, type IndexMessage } from "../../shared/search-index-protocol.ts";
import { textSum } from "../../shared/search-index-query.ts";
import { peerProvenanceAuthor } from "../peer-provenance.ts";

export interface IndexRead {
  sql: string;
  params: SQLInputValue[];
}

export const INDEX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PEER_HEAD_CHARS = 160;

export interface MessageRow {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  from_name: string | null;
  peer_name: string | null;
}

export interface MemoryRow {
  bot_id: string;
  path: string;
  text: string;
  mtime_ms: number;
  bytes: number;
}

const MESSAGE_COLUMNS =
  "thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, " +
  "json_extract(json, '$.from.name') AS from_name, json_extract(json, '$.peerAsk.name') AS peer_name";

export function messagesByKeys(keys: ReadonlyArray<{ chat: string; id: string }>): IndexRead {
  return {
    sql: `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE (thread_id, id) IN ` +
      "(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
    params: [JSON.stringify(keys.map((key) => [key.chat, key.id]))],
  };
}

export function memoryByKeys(keys: ReadonlyArray<{ dog: string; path: string }>): IndexRead {
  return {
    sql: "SELECT bot_id, path, text, mtime_ms, bytes FROM memory_files WHERE (bot_id, path) IN " +
      "(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
    params: [JSON.stringify(keys.map((key) => [key.dog, key.path]))],
  };
}

export function chatPage(chat: string, afterRowid: number, limit: number): IndexRead {
  return { sql: "SELECT rowid AS r, id FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?", params: [chat, afterRowid, limit] };
}

export const ALL_CHATS: IndexRead = { sql: "SELECT DISTINCT thread_id AS chat FROM messages", params: [] };
export const MEMORY_DOGS: IndexRead = { sql: "SELECT DISTINCT bot_id AS dog FROM memory_files", params: [] };

export function memoryPaths(dog: string): IndexRead {
  return { sql: "SELECT path FROM memory_files WHERE bot_id = ?", params: [dog] };
}

export function memoryTexts(dog: string): IndexRead {
  return { sql: "SELECT path, text FROM memory_files WHERE bot_id = ? ORDER BY path", params: [dog] };
}

export function indexText(row: Pick<MessageRow, "kind" | "text" | "tool_name">): string {
  return ((row.kind === "activity" ? row.tool_name : row.text) ?? "").slice(0, INDEX_TEXT_MAX_CHARS);
}

export function indexedMessage(row: MessageRow, dog: string): IndexMessage {
  const text = row.text ?? "";
  const peer = row.peer_name ?? peerProvenanceAuthor(Array.from(text.slice(0, PEER_HEAD_CHARS * 2)).slice(0, PEER_HEAD_CHARS).join(""));
  return {
    chat: row.thread_id,
    id: row.id,
    dog,
    at: row.at,
    role: row.role,
    kind: row.kind,
    text: indexText(row),
    ...(row.from_name ? { from: row.from_name } : {}),
    ...(peer ? { peer } : {}),
  };
}

export function indexedMemory(row: MemoryRow): IndexMemoryFile {
  return { dog: row.bot_id, path: row.path, text: row.text.slice(0, INDEX_TEXT_MAX_CHARS), mtime: row.mtime_ms, bytes: row.bytes };
}

export function messageSum(row: MessageRow): string {
  return textSum(indexText(row));
}

export function memorySum(row: MemoryRow): string {
  return textSum(row.text.slice(0, INDEX_TEXT_MAX_CHARS));
}
