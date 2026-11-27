import type { RecallRange, SearchMode } from "./search-index-query.ts";

export const INDEX_ROUTE = "/api/internal/index/";
export const INDEX_FEED_MAX_ITEMS = 250;
export const INDEX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const INDEX_KIND = /^[a-z][a-z_.-]{0,31}$/;
export const INDEX_TEXT_MAX_CHARS = 400_000;
export const INDEX_SCOPE_MAX = 5_000;
export const INDEX_BUDGET_MS = { recall: 500, recent: 500, memory: 500, search: 1_000, has: 1_000, files: 500, feed: 10_000, stats: 1_000 } as const;
export const INDEX_FEED_MAX_SHARDS = 64;
export type IndexOperation = keyof typeof INDEX_BUDGET_MS;

export interface IndexShards {
  dogs?: string[];
  person?: boolean;
}

export interface IndexMessage extends IndexShards {
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

export interface IndexMemoryFile extends IndexShards {
  dog: string;
  path: string;
  text: string;
  mtime: number;
  bytes: number;
}

export interface IndexFeedBatch {
  messages?: IndexMessage[];
  removeMessages?: Array<{ chat: string; id: string } & IndexShards>;
  removeChats?: Array<{ chat: string } & IndexShards>;
  memory?: IndexMemoryFile[];
  removeMemory?: Array<{ dog: string; path: string } & IndexShards>;
}

export interface IndexShardChoice {
  dog?: string;
}

export interface IndexHasRequest extends IndexShardChoice {
  messages?: Array<{ chat: string; id: string }>;
  memory?: Array<{ dog: string; path: string }>;
}

export interface IndexHasAnswer {
  messages: Array<{ chat: string; id: string; at: number; kind: string; sum: string }>;
  memory: Array<{ dog: string; path: string; mtime: number; sum: string }>;
}

export interface IndexRecallRequest extends IndexShardChoice {
  query: string;
  chats: string[];
  limit?: number;
  range?: RecallRange;
  mode?: SearchMode;
}

export interface IndexRecentRequest extends IndexShardChoice {
  chats: string[];
  limit?: number;
  range?: RecallRange;
}

export interface IndexMemoryRequest extends IndexShardChoice {
  query: string;
  dogs: string[];
  limit?: number;
  mode?: SearchMode;
  each?: boolean;
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

export interface IndexFilesRequest extends IndexShardChoice {
  dogs: string[];
}

export interface IndexMemoryText {
  dog: string;
  path: string;
  text: string;
  mtime: number;
}

export interface IndexStatsRequest extends IndexShardChoice {}

export interface IndexStats {
  messages: number;
  memoryFiles: number;
  bytes: number;
}
