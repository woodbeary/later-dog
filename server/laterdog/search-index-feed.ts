import {
  INDEX_BUDGET_MS,
  INDEX_FEED_MAX_ITEMS,
  INDEX_ROUTE,
  INDEX_TEXT_MAX_CHARS,
  type IndexFeedBatch,
  type IndexMemoryFile,
  type IndexMemoryHit,
  type IndexMemoryRequest,
  type IndexMessage,
  type IndexOperation,
  type IndexRecallHit,
  type IndexRecallRequest,
  type IndexRecentRequest,
  type IndexSearchHit,
  type IndexSearchRequest,
  type IndexStats,
} from "../../shared/search-index-protocol.ts";
import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";

export interface IndexableMessage {
  id: string;
  at: number;
  role: string;
  kind: string;
  text?: string | null;
  tool?: { name?: string | null } | null;
  from?: { name?: string | null } | null;
}

export function indexMessage(dog: string, chat: string, message: IndexableMessage, peer?: string | null): IndexMessage {
  const text = (message.kind === "activity" ? message.tool?.name : message.text) ?? "";
  return {
    chat,
    id: message.id,
    dog,
    at: message.at,
    role: message.role,
    kind: message.kind,
    text: text.slice(0, INDEX_TEXT_MAX_CHARS),
    ...(message.from?.name ? { from: message.from.name } : {}),
    ...(peer ? { peer } : {}),
  };
}

type Pending =
  | { kind: "message"; value: IndexMessage }
  | { kind: "removeMessage"; value: { chat: string; id: string } }
  | { kind: "removeChat"; value: string }
  | { kind: "memory"; value: IndexMemoryFile }
  | { kind: "removeMemory"; value: { dog: string; path: string } };

export interface FeedOptions {
  maxBatch?: number;
  delayMs?: number;
  maxPending?: number;
  retryMs?: readonly number[];
}

export interface FeedState {
  pending: number;
  sent: number;
  failures: number;
  dropped: number;
  needsBackfill: boolean;
}

export class SearchIndexFeed {
  private readonly pending = new Map<string, Pending>();
  private readonly maxBatch: number;
  private readonly delayMs: number;
  private readonly maxPending: number;
  private readonly retryMs: readonly number[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly waiters: Array<() => void> = [];
  readonly state: FeedState = { pending: 0, sent: 0, failures: 0, dropped: 0, needsBackfill: false };

  private readonly send: (batch: IndexFeedBatch) => Promise<void>;

  constructor(send: (batch: IndexFeedBatch) => Promise<void>, options: FeedOptions = {}) {
    this.send = send;
    this.maxBatch = Math.min(options.maxBatch ?? INDEX_FEED_MAX_ITEMS, INDEX_FEED_MAX_ITEMS);
    this.delayMs = options.delayMs ?? 250;
    this.maxPending = options.maxPending ?? 50_000;
    this.retryMs = options.retryMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
  }

  message(dog: string, chat: string, message: IndexableMessage, peer?: string | null): void {
    this.put(`m ${chat} ${message.id}`, { kind: "message", value: indexMessage(dog, chat, message, peer) });
  }

  removeMessage(chat: string, id: string): void {
    this.put(`m ${chat} ${id}`, { kind: "removeMessage", value: { chat, id } });
  }

  removeChat(chat: string): void {
    for (const [key, item] of this.pending) {
      if (item.kind === "message" && item.value.chat === chat) this.pending.delete(key);
      if (item.kind === "removeMessage" && item.value.chat === chat) this.pending.delete(key);
    }
    this.put(`c ${chat}`, { kind: "removeChat", value: chat });
  }

  memory(file: IndexMemoryFile): void {
    this.put(`f ${file.dog} ${file.path}`, { kind: "memory", value: { ...file, text: file.text.slice(0, INDEX_TEXT_MAX_CHARS) } });
  }

  removeMemory(dog: string, path: string): void {
    this.put(`f ${dog} ${path}`, { kind: "removeMemory", value: { dog, path } });
  }

  drained(): Promise<void> {
    if (!this.pending.size && !this.flushing) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flushing ??= this.flushAll().finally(() => {
      this.flushing = null;
      if (this.pending.size) this.schedule(this.attempt ? this.retryMs[Math.min(this.attempt, this.retryMs.length) - 1]! : this.delayMs);
      else for (const resolve of this.waiters.splice(0)) resolve();
    });
    return this.flushing;
  }

  private put(key: string, item: Pending): void {
    if (this.stopped) return;
    this.pending.delete(key);
    this.pending.set(key, item);
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
      this.state.dropped += 1;
      this.state.needsBackfill = true;
    }
    this.state.pending = this.pending.size;
    if (!this.attempt) this.schedule(this.delayMs);
  }

  private schedule(ms: number): void {
    if (this.timer || this.flushing || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private async flushAll(): Promise<void> {
    while (this.pending.size && !this.stopped) {
      const taken = [...this.pending.entries()].slice(0, this.maxBatch);
      for (const [key] of taken) this.pending.delete(key);
      try {
        await this.send(batchOf(taken.map(([, item]) => item)));
        this.state.sent += taken.length;
        this.attempt = 0;
      } catch {
        for (const [key, item] of taken) if (!this.pending.has(key)) this.pending.set(key, item);
        this.state.failures += 1;
        this.attempt += 1;
        break;
      } finally {
        this.state.pending = this.pending.size;
      }
    }
  }
}

function batchOf(items: Pending[]): IndexFeedBatch {
  const batch: Required<IndexFeedBatch> = { messages: [], removeMessages: [], removeChats: [], memory: [], removeMemory: [] };
  for (const item of items) {
    if (item.kind === "message") batch.messages.push(item.value);
    else if (item.kind === "removeMessage") batch.removeMessages.push(item.value);
    else if (item.kind === "removeChat") batch.removeChats.push(item.value);
    else if (item.kind === "memory") batch.memory.push(item.value);
    else batch.removeMemory.push(item.value);
  }
  return Object.fromEntries(Object.entries(batch).filter(([, list]) => list.length)) as IndexFeedBatch;
}

export interface IndexClientOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  budgets?: Partial<Record<IndexOperation, number>>;
}

export interface SearchIndexClient {
  feed(batch: IndexFeedBatch): Promise<void>;
  recall(request: IndexRecallRequest): Promise<IndexRecallHit[] | null>;
  recent(request: IndexRecentRequest): Promise<IndexRecallHit[] | null>;
  memory(request: IndexMemoryRequest): Promise<IndexMemoryHit[] | null>;
  search(request: IndexSearchRequest): Promise<IndexSearchHit[] | null>;
  stats(): Promise<IndexStats | null>;
}

const CLIENT_SLACK_MS = 250;
const TOKEN_MS = 5 * 60_000;

export function searchIndexClient(options: IndexClientOptions): SearchIndexClient {
  const secret = capabilitySecret(options.bootstrapSecret);
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let token = { value: "", expiresAt: 0 };
  const bearer = () => {
    const at = now();
    if (token.expiresAt - at < 60_000) {
      token = {
        value: signCapabilitySync(secret, { home: options.home, dog: "home", chat: "home", generation: "index", kind: "index", issuedAt: at, expiresAt: at + TOKEN_MS }),
        expiresAt: at + TOKEN_MS,
      };
    }
    return token.value;
  };
  async function call<T>(operation: IndexOperation, body: unknown): Promise<T> {
    const budget = (options.budgets?.[operation] ?? INDEX_BUDGET_MS[operation]) + CLIENT_SLACK_MS;
    const response = await send(`${options.origin}${INDEX_ROUTE}${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer()}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(budget),
    });
    if (!response.ok) throw new Error(`index ${operation} answered ${response.status}`);
    const answer = (await response.json()) as { ok?: boolean; result?: T };
    if (!answer.ok) throw new Error(`index ${operation} refused`);
    return answer.result as T;
  }
  const orNull = async <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
  return {
    feed: async (batch) => void (await call("feed", batch)),
    recall: (request) => orNull(call("recall", request)),
    recent: (request) => orNull(call("recent", request)),
    memory: (request) => orNull(call("memory", request)),
    search: (request) => orNull(call("search", request)),
    stats: () => orNull(call("stats", {})),
  };
}

export interface HitComparison {
  same: boolean;
  missing: string[];
  extra: string[];
}

export function compareHits(local: ReadonlyArray<{ threadId: string; messageId: string }>, remote: ReadonlyArray<{ threadId: string; messageId: string }>): HitComparison {
  const key = (hit: { threadId: string; messageId: string }) => `${hit.threadId}/${hit.messageId}`;
  const remoteKeys = new Set(remote.map(key));
  const localKeys = new Set(local.map(key));
  const missing = [...localKeys].filter((item) => !remoteKeys.has(item));
  const extra = [...remoteKeys].filter((item) => !localKeys.has(item));
  return { same: !missing.length && !extra.length && local.map(key).join() === remote.map(key).join(), missing, extra };
}
