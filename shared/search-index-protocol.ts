import type { RecallRange, SearchMode } from "./search-index-query.ts";

export const INDEX_ROUTE = "/api/internal/index/";
export const INDEX_FEED_MAX_ITEMS = 2_000;
export const INDEX_TEXT_MAX_CHARS = 64_000;
export const INDEX_SCOPE_MAX = 5_000;
export const INDEX_BUDGET_MS = { recall: 500, recent: 500, memory: 500, search: 1_000, feed: 10_000, stats: 1_000 } as const;
export type IndexOperation = keyof typeof INDEX_BUDGET_MS;

export interface IndexMessage {
  chat: string;
  id: string;
  dog: string;
  at: number;
  role: string;
  kind: string;
  text: string;
  from?: string;
  peer?: string;
}

export interface IndexMemoryFile {
  dog: string;
  path: string;
  text: string;
  mtime: number;
  bytes: number;
}

export interface IndexFeedBatch {
  messages?: IndexMessage[];
  removeMessages?: Array<{ chat: string; id: string }>;
  removeChats?: string[];
  memory?: IndexMemoryFile[];
  removeMemory?: Array<{ dog: string; path: string }>;
}

export interface IndexRecallRequest {
  query: string;
  chats: string[];
  limit?: number;
  range?: RecallRange;
  mode?: SearchMode;
}

export interface IndexRecentRequest {
  chats: string[];
  limit?: number;
  range?: RecallRange;
}

export interface IndexMemoryRequest {
  query: string;
  dogs: string[];
  limit?: number;
  mode?: SearchMode;
}

export interface IndexSearchRequest {
  query: string;
  limit?: number;
  chats?: string[];
}

export interface IndexRecallHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind?: "digest";
  snippet: string;
  from?: string;
  peer?: string;
}

export interface IndexMemoryHit {
  dog: string;
  file: string;
  snippet: string;
  at: number;
}

export interface IndexSearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  from?: string;
}

export interface IndexStats {
  messages: number;
  chats: number;
  dogs: number;
  memoryFiles: number;
  bytes: number;
}
