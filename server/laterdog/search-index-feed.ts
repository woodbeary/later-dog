import {
  INDEX_BUDGET_MS,
  INDEX_FEED_MAX_ITEMS,
  INDEX_ROUTE,
  type IndexFeedBatch,
  type IndexHasAnswer,
  type IndexFilesRequest,
  type IndexHasRequest,
  type IndexMemoryText,
  type IndexMemoryHit,
  type IndexMemoryRequest,
  type IndexOperation,
  type IndexRecallHit,
  type IndexRecallRequest,
  type IndexRecentRequest,
  type IndexSearchHit,
  type IndexSearchRequest,
  type IndexStats,
} from "../../shared/search-index-protocol.ts";
import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";

export type FeedKey =
  | { kind: "message"; chat: string; id: string }
  | { kind: "chat"; chat: string }
  | { kind: "memory"; dog: string; path: string };

export interface FeedTargets {
  dogs?: readonly string[];
  person?: boolean;
}

export interface FeedEntry {
  key: FeedKey;
  auto: boolean;
  dogs: ReadonlySet<string>;
  person: boolean;
}

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
  lastError: string | null;
}

export function chatOf(key: FeedKey): string {
  return key.kind === "memory" ? `@memory:${key.dog}` : key.chat;
}

function keyOf(key: FeedKey): string {
  if (key.kind === "message") return `m ${key.chat} ${key.id}`;
  if (key.kind === "chat") return `c ${key.chat}`;
  return `f ${key.dog} ${key.path}`;
}

export class SearchIndexFeed {
  private readonly pending = new Map<string, { key: FeedKey; auto: boolean; dogs: Set<string>; person: boolean }>();
  private readonly maxBatch: number;
  private readonly delayMs: number;
  private readonly maxPending: number;
  private readonly retryMs: readonly number[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private attempt = 0;
  private stopped = false;
  private inflight: FeedKey[] = [];
  private readonly waiters: Array<() => void> = [];
  readonly state: FeedState = { pending: 0, sent: 0, failures: 0, dropped: 0, lastError: null };

  private readonly send: (batch: IndexFeedBatch) => Promise<void>;
  private readonly resolve: (entries: FeedEntry[]) => Promise<IndexFeedBatch>;
  private readonly onDrop: () => void;
  private readonly onSent: (keys: FeedKey[]) => void;
  private readonly onRefused: (keys: FeedKey[], reason: string) => void;

  constructor(send: (batch: IndexFeedBatch) => Promise<void>, resolve: (entries: FeedEntry[]) => Promise<IndexFeedBatch>, options: FeedOptions & { onDrop?: () => void; onSent?: (keys: FeedKey[]) => void; onRefused?: (keys: FeedKey[], reason: string) => void } = {}) {
    this.send = send;
    this.resolve = resolve;
    this.onDrop = options.onDrop ?? (() => {});
    this.onSent = options.onSent ?? (() => {});
    this.onRefused = options.onRefused ?? (() => {});
    this.maxBatch = Math.min(options.maxBatch ?? INDEX_FEED_MAX_ITEMS, INDEX_FEED_MAX_ITEMS);
    this.delayMs = options.delayMs ?? 250;
    this.maxPending = options.maxPending ?? 200_000;
    this.retryMs = options.retryMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
  }

  get failing(): boolean {
    return this.attempt > 0;
  }

  get size(): number {
    return this.pending.size;
  }

  busy(chats: Iterable<string>): boolean {
    if (!this.pending.size && !this.inflight.length) return false;
    const scope = new Set(chats);
    for (const entry of this.pending.values()) if (scope.has(chatOf(entry.key))) return true;
    return this.inflight.some((key) => scope.has(chatOf(key)));
  }

  message(chat: string, id: string, targets?: FeedTargets): void {
    this.put({ kind: "message", chat, id }, targets);
  }

  removeChat(chat: string, targets?: FeedTargets): void {
    for (const [name, entry] of this.pending) if (entry.key.kind === "message" && entry.key.chat === chat) this.pending.delete(name);
    this.put({ kind: "chat", chat }, targets);
  }

  memory(dog: string, path: string, targets?: FeedTargets): void {
    this.put({ kind: "memory", dog, path }, targets);
  }

  drained(): Promise<void> {
    if (!this.pending.size && !this.flushing) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flushing ??= this.flushAll().finally(() => {
      this.flushing = null;
      if (this.pending.size && !this.stopped) this.schedule(this.attempt ? this.retryMs[Math.min(this.attempt, this.retryMs.length) - 1]! : this.delayMs);
      else for (const resolve of this.waiters.splice(0)) resolve();
    });
    return this.flushing;
  }

  private put(key: FeedKey, targets?: FeedTargets): void {
    if (this.stopped) return;
    const name = keyOf(key);
    const held = this.pending.get(name);
    this.pending.delete(name);
    const entry = { key, auto: targets === undefined || Boolean(held?.auto), dogs: new Set(held?.dogs ?? []), person: Boolean(held?.person) };
    for (const dog of targets?.dogs ?? []) entry.dogs.add(dog);
    if (targets?.person) entry.person = true;
    this.pending.set(name, entry);
    if (this.pending.size > this.maxPending) {
      this.state.dropped += this.pending.size;
      this.pending.clear();
      this.onDrop();
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
      for (const [name] of taken) this.pending.delete(name);
      this.inflight = taken.map(([, entry]) => entry.key);
      try {
        const batch = await this.resolve(taken.map(([, entry]) => entry));
        if (Object.keys(batch).length) await this.send(batch);
        this.state.sent += taken.length;
        this.onSent(taken.filter(([name, entry]) => (entry.auto || entry.key.kind === "chat") && !this.pending.has(name)).map(([, entry]) => entry.key));
        this.attempt = 0;
        this.state.lastError = null;
      } catch (error) {
        if ((error as { status?: unknown }).status === 400) {
          this.state.dropped += taken.length;
          this.state.lastError = error instanceof Error ? error.message : String(error);
          this.onRefused(taken.map(([, entry]) => entry.key), this.state.lastError);
          continue;
        }
        for (const [name, entry] of taken) if (!this.pending.has(name)) this.pending.set(name, entry);
        this.state.failures += 1;
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.attempt += 1;
        break;
      } finally {
        this.inflight = [];
        this.state.pending = this.pending.size;
      }
    }
  }
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
  has(request: IndexHasRequest): Promise<IndexHasAnswer | null>;
  files(request: IndexFilesRequest): Promise<IndexMemoryText[] | null>;
  stats(dog?: string): Promise<IndexStats | null>;
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
    if (!response.ok) throw Object.assign(new Error(`index ${operation} answered ${response.status}`), { status: response.status });
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
    has: (request) => orNull(call("has", request)),
    files: (request) => orNull(call("files", request)),
    stats: (dog) => orNull(call("stats", dog ? { dog } : {})),
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
