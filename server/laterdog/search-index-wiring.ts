import type { IndexFeedBatch, IndexRecallHit } from "../../shared/search-index-protocol.ts";
import type { RecallRange, SearchMode } from "../../shared/search-index-query.ts";
import { SearchIndexFeed, chatOf, type FeedEntry, type FeedKey, type SearchIndexClient } from "./search-index-feed.ts";
import {
  ALL_CHATS,
  INDEX_ID,
  INDEX_KIND,
  MEMORY_DOGS,
  chatPage,
  indexedMemory,
  indexedMessage,
  memoryByKeys,
  memoryPaths,
  memoryTexts,
  memorySum,
  messageSum,
  messagesByKeys,
  type IndexRead,
  type MemoryRow,
  type MessageRow,
} from "./search-index-rows.ts";

export const SEARCH_INDEX_MODES = ["off", "shadow", "remote"] as const;
export type SearchIndexMode = (typeof SEARCH_INDEX_MODES)[number];

export const PERSON_TARGET = "@person";
const MEMORY_CHAT = "@memory:";
const PAGE = 250;
const RESCAN_MS = 30 * 60_000;
const SAMPLES = 20;
const TIMINGS = 500;
export const PROMPT_SNAPSHOT_WAIT_MS = 1_500;
export const SHADOW_INDEX_BUDGETS = { recall: 10_000, recent: 10_000, memory: 10_000, has: 10_000 } as const;

export interface CoverageStore {
  read(): Array<{ chat: string; target: string }>;
  add(chat: string, targets: readonly string[]): void;
  drop(chat: string): void;
  clear(): void;
}

export interface IndexOutbox {
  put(key: FeedKey): void;
  all(): FeedKey[];
  remove(keys: readonly FeedKey[]): void;
  clear(): void;
}

export interface SearchIndexWiringDeps {
  client: SearchIndexClient;
  shadowClient?: SearchIndexClient;
  outbox: IndexOutbox;
  read(reads: IndexRead[]): Promise<unknown[][]>;
  coverage: CoverageStore;
  ownersOf(chat: string): readonly string[];
  log(line: string): void;
  pageGapMs?: number;
  feedDelayMs?: number;
}

export interface RecallAsk {
  dog?: string;
  query: string;
  chats: readonly string[];
  limit: number;
  range?: RecallRange;
  mode?: SearchMode;
}

export interface RecentAsk {
  dog?: string;
  chats: readonly string[];
  limit: number;
  range: RecallRange;
}

export interface MemoryAsk {
  shard?: string;
  query: string;
  dogs: readonly string[];
  limit: number;
  mode?: SearchMode;
}

export type LocalMemoryHit = { file: string; snippet: string; at: number };

type Outcome = "same" | "ranked" | "mismatch" | "unavailable" | "refused" | "skipped";

export interface SearchIndexStatus {
  mode: SearchIndexMode;
  feed: SearchIndexFeed["state"] & { failing: boolean };
  backfill: { running: boolean; chatsCovered: number; chatsQueued: number; lastScanAt: number | null; current: string | null };
  shadow: Record<Outcome, number> & { compared: number; samples: Array<Record<string, unknown>> };
  remote: { answered: number; fellBack: number };
  prompt: { snapshot: number; index: number; local: number; mountReadsAvoided: number; shadowMountReads: number };
  timings: Record<string, { n: number; p50: number | null; p95: number | null }>;
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
}

const pause = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export class SearchIndexWiring {
  private modeNow: SearchIndexMode = "off";
  private feed: SearchIndexFeed | null = null;
  private readonly covered = new Map<string, Set<string>>();
  private readonly queued = new Map<string, Set<string>>();
  private readonly cancelled = new Set<string>();
  private backfilling: Promise<void> | null = null;
  private current: string | null = null;
  private lastScanAt: number | null = null;
  private generation = 0;
  private readonly shadow: SearchIndexStatus["shadow"] = { compared: 0, same: 0, ranked: 0, mismatch: 0, unavailable: 0, refused: 0, skipped: 0, samples: [] };
  private readonly remote = { answered: 0, fellBack: 0 };
  private readonly prompt = { snapshot: 0, index: 0, local: 0, mountReadsAvoided: 0, shadowMountReads: 0 };
  private readonly timings = new Map<string, number[]>();
  private readonly lastWrite = new Map<string, number>();
  private seq = 0;
  private unindexable = 0;
  private readonly checks = new Set<Promise<void>>();
  private readonly deps: SearchIndexWiringDeps;

  constructor(deps: SearchIndexWiringDeps) {
    this.deps = deps;
  }

  get mode(): SearchIndexMode {
    return this.modeNow;
  }

  setMode(mode: SearchIndexMode): void {
    if (mode === this.modeNow) return;
    const was = this.modeNow;
    this.modeNow = mode;
    this.deps.log(`search-index: mode ${was} -> ${mode}`);
    if (mode === "off") {
      this.generation += 1;
      this.feed?.stop();
      this.feed = null;
      this.queued.clear();
      return;
    }
    if (was === "off") this.start();
  }

  private start(): void {
    this.generation += 1;
    this.covered.clear();
    this.staleWhileOff.clear();
    this.lastScanAt = null;
    for (const { chat, target } of this.deps.coverage.read()) this.coverageOf(chat).add(target);
    this.feed = new SearchIndexFeed((batch) => this.deps.client.feed(batch), (entries) => this.resolve(entries), {
      delayMs: this.deps.feedDelayMs,
      onDrop: () => {
        this.deps.log("search-index: the feed fell too far behind; every chat is fed again");
        this.covered.clear();
        this.deps.coverage.clear();
        this.deps.outbox.clear();
        this.lastScanAt = null;
        this.wake();
      },
      onRefused: (keys, reason) => {
        const chats = new Set(keys.map((key) => chatOf(key)));
        this.deps.log(`search-index: the index refused a batch (${reason}); ${chats.size} chat(s) answer from the home until fed again`);
        for (const chat of chats) {
          this.covered.delete(chat);
          this.deps.coverage.drop(chat);
        }
        try {
          this.deps.outbox.remove(keys);
        } catch {}
      },
      onSent: (keys) => {
        try {
          this.deps.outbox.remove(keys);
        } catch (error) {
          this.deps.log(`search-index: outbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    for (const key of this.deps.outbox.all()) {
      if (key.kind === "message") this.feed.message(key.chat, key.id);
      else if (key.kind === "memory") this.feed.memory(key.dog, key.path);
      else this.feed.removeChat(key.chat, { person: true });
    }
    this.wake();
  }

  stop(): void {
    this.setMode("off");
  }

  refeed(): void {
    this.deps.coverage.clear();
    this.covered.clear();
    this.queued.clear();
    this.lastScanAt = null;
    if (this.feed) this.wake();
  }

  private get shadowClient(): SearchIndexClient {
    return this.deps.shadowClient ?? this.deps.client;
  }

  private touch(chat: string): void {
    this.lastWrite.set(chat, ++this.seq);
  }

  private window(chats: readonly string[]): ShadowWindow {
    return { marks: new Map(chats.map((chat) => [chat, this.lastWrite.get(chat) ?? 0])), busy: new Set(chats.filter((chat) => this.feed?.busy([chat]))) };
  }

  private unsettled(window: ShadowWindow): Set<string> {
    const out = new Set(window.busy);
    for (const [chat, mark] of window.marks) if ((this.lastWrite.get(chat) ?? 0) !== mark || this.feed?.busy([chat])) out.add(chat);
    return out;
  }

  private readonly staleWhileOff = new Set<string>();

  private stale(chat: string): void {
    if (this.staleWhileOff.has(chat)) return;
    this.staleWhileOff.add(chat);
    this.deps.coverage.drop(chat);
  }

  wrote = {
    message: (chat: string, id: string) => {
      if (!this.feed) return this.stale(chat);
      this.touch(chat);
      this.deps.outbox.put({ kind: "message", chat, id });
      this.feed.message(chat, id);
    },
    chat: (chat: string) => {
      if (!this.feed) {
        this.stale(chat);
        this.deps.outbox.put({ kind: "chat", chat });
        return;
      }
      this.touch(chat);
      const targets = [...(this.covered.get(chat) ?? [])];
      this.cancelled.add(chat);
      this.queued.delete(chat);
      this.covered.delete(chat);
      this.deps.coverage.drop(chat);
      this.deps.outbox.put({ kind: "chat", chat });
      this.feed.removeChat(chat, { dogs: targets.filter((target) => target !== PERSON_TARGET), person: true });
    },
    memory: (dog: string, path: string) => {
      if (!this.feed) {
        this.stale(`${MEMORY_CHAT}${dog}`);
        this.deps.outbox.put({ kind: "memory", dog, path });
        return;
      }
      this.touch(`${MEMORY_CHAT}${dog}`);
      this.deps.outbox.put({ kind: "memory", dog, path });
      this.feed.memory(dog, path);
    },
  };

  private coverageOf(chat: string): Set<string> {
    let held = this.covered.get(chat);
    if (!held) this.covered.set(chat, held = new Set());
    return held;
  }

  private wanted(chat: string): string[] {
    if (chat.startsWith(MEMORY_CHAT)) return [chat.slice(MEMORY_CHAT.length), PERSON_TARGET];
    return [PERSON_TARGET, ...this.deps.ownersOf(chat).filter((dog) => INDEX_ID.test(dog))];
  }

  private missing(chat: string, targets: readonly string[]): string[] {
    const have = this.covered.get(chat);
    return targets.filter((target) => !have?.has(target));
  }

  private queue(chat: string, targets: readonly string[]): void {
    if (!targets.length || !this.feed) return;
    let held = this.queued.get(chat);
    if (!held) this.queued.set(chat, held = new Set());
    for (const target of targets) held.add(target);
    this.wake();
  }

  private wake(): void {
    if (this.backfilling || !this.feed) return;
    const generation = this.generation;
    this.backfilling = this.backfill(generation)
      .catch((error: unknown) => this.deps.log(`search-index: backfill stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.backfilling = null;
        this.current = null;
        if (this.feed && generation === this.generation && this.queued.size) this.wake();
      });
  }

  private async scan(): Promise<void> {
    const [chats, dogs] = await this.deps.read([ALL_CHATS, MEMORY_DOGS]) as [Array<{ chat: string }>, Array<{ dog: string }>];
    for (const { chat } of chats) if (INDEX_ID.test(chat)) this.queue(chat, this.missing(chat, this.wanted(chat)));
    for (const { dog } of dogs) if (INDEX_ID.test(dog)) this.queue(`${MEMORY_CHAT}${dog}`, this.missing(`${MEMORY_CHAT}${dog}`, this.wanted(`${MEMORY_CHAT}${dog}`)));
    this.lastScanAt = Date.now();
  }

  private async backfill(generation: number): Promise<void> {
    const live = () => this.feed !== null && generation === this.generation;
    if (this.lastScanAt === null || Date.now() - this.lastScanAt > RESCAN_MS) await this.scan();
    while (live() && this.queued.size) {
      const [chat, targets] = this.queued.entries().next().value as [string, Set<string>];
      this.queued.delete(chat);
      this.cancelled.delete(chat);
      this.current = chat;
      const list = [...targets];
      const shards = { dogs: list.filter((target) => target !== PERSON_TARGET), person: list.includes(PERSON_TARGET) };
      if (chat.startsWith(MEMORY_CHAT)) {
        const dog = chat.slice(MEMORY_CHAT.length);
        const [paths] = await this.deps.read([memoryPaths(dog)]) as [Array<{ path: string }>];
        for (const { path } of paths) this.feed?.memory(dog, path, { dogs: [], person: shards.person });
      } else {
        let after = 0;
        for (;;) {
          const [rows] = await this.deps.read([chatPage(chat, after, PAGE)]) as [Array<{ r: number; id: string }>];
          for (const row of rows) this.feed?.message(chat, row.id, shards);
          if (rows.length < PAGE || !live() || this.cancelled.has(chat)) break;
          after = rows[rows.length - 1]!.r;
          await this.feed?.drained();
          await pause(this.deps.pageGapMs ?? 100);
        }
      }
      await this.feed?.drained();
      if (!live() || this.cancelled.has(chat)) continue;
      this.coverageOf(chat);
      for (const target of list) this.covered.get(chat)!.add(target);
      this.deps.coverage.add(chat, list);
      await pause(this.deps.pageGapMs ?? 100);
    }
  }

  private async resolve(entries: FeedEntry[]): Promise<IndexFeedBatch> {
    const messageKeys = entries.flatMap((entry) => entry.key.kind === "message" ? [entry.key] : []);
    const memoryKeys = entries.flatMap((entry) => entry.key.kind === "memory" ? [entry.key] : []);
    const reads: IndexRead[] = [messagesByKeys(messageKeys), memoryByKeys(memoryKeys)];
    const [messageRows, memoryRows] = await this.deps.read(reads) as [MessageRow[], MemoryRow[]];
    const messages = new Map(messageRows.map((row) => [`${row.thread_id}\n${row.id}`, row]));
    const memory = new Map(memoryRows.map((row) => [`${row.bot_id}\n${row.path}`, row]));
    const batch: Required<IndexFeedBatch> = { messages: [], removeMessages: [], removeChats: [], memory: [], removeMemory: [] };
    for (const entry of entries) {
      const key = entry.key;
      if (key.kind === "chat") {
        if (INDEX_ID.test(key.chat)) batch.removeChats.push({ chat: key.chat, dogs: [...entry.dogs].filter((dog) => INDEX_ID.test(dog)), person: true });
        continue;
      }
      if (key.kind === "memory") {
        if (!INDEX_ID.test(key.dog)) continue;
        const row = memory.get(`${key.dog}\n${key.path}`);
        const person = entry.person || entry.auto;
        if (row) batch.memory.push({ ...indexedMemory(row), person });
        else batch.removeMemory.push({ dog: key.dog, path: key.path, person });
        if (entry.auto) this.queue(`${MEMORY_CHAT}${key.dog}`, this.missing(`${MEMORY_CHAT}${key.dog}`, this.wanted(`${MEMORY_CHAT}${key.dog}`)));
        continue;
      }
      if (!INDEX_ID.test(key.chat) || !INDEX_ID.test(key.id)) continue;
      const owners = entry.auto ? this.wanted(key.chat).filter((target) => target !== PERSON_TARGET) : [];
      const dogs = [...new Set([...entry.dogs, ...owners])].filter((dog) => INDEX_ID.test(dog));
      const person = entry.person || entry.auto;
      if (entry.auto) this.queue(key.chat, this.missing(key.chat, this.wanted(key.chat)));
      if (!dogs.length && !person) continue;
      const row = messages.get(`${key.chat}\n${key.id}`);
      if (row && INDEX_KIND.test(row.kind)) batch.messages.push({ ...indexedMessage(row, dogs[0] ?? "home"), dogs, person });
      else if (row) this.unindexable += 1;
      else batch.removeMessages.push({ chat: key.chat, id: key.id, dogs, person });
    }
    return Object.fromEntries(Object.entries(batch).filter(([, list]) => list.length)) as IndexFeedBatch;
  }

  private ready(chats: readonly string[], target: string, settled = true): boolean {
    const feed = this.feed;
    if (!feed || feed.failing) return false;
    let ok = true;
    for (const chat of chats) {
      const missing = this.missing(chat, [target]);
      if (missing.length) {
        ok = false;
        const wanted = this.wanted(chat);
        if (wanted.includes(target) || target === PERSON_TARGET) this.queue(chat, missing);
      }
    }
    return ok && (!settled || !feed.busy(chats));
  }

  private time(op: string, ms: number): void {
    let list = this.timings.get(op);
    if (!list) this.timings.set(op, list = []);
    list.push(ms);
    if (list.length > TIMINGS) list.splice(0, list.length - TIMINGS);
  }

  private async timed<T>(op: string, work: Promise<T | null>): Promise<T | null> {
    const started = performance.now();
    const result = await work;
    if (result !== null) this.time(op, performance.now() - started);
    return result;
  }

  private count(outcome: Outcome, sample?: Record<string, unknown>): void {
    this.shadow[outcome] += 1;
    if (outcome !== "skipped" && outcome !== "unavailable") this.shadow.compared += 1;
    if (sample && outcome === "mismatch") {
      this.shadow.samples.push({ at: new Date().toISOString(), ...sample });
      if (this.shadow.samples.length > SAMPLES) this.shadow.samples.splice(0, this.shadow.samples.length - SAMPLES);
      this.deps.log(`search-index: shadow mismatch ${JSON.stringify(sample)}`);
    }
  }

  async recall(ask: RecallAsk, local: () => Promise<IndexRecallHit[]>): Promise<IndexRecallHit[]> {
    return this.answer("recall", ask.dog ?? PERSON_TARGET, ask.chats, local, (client) => client.recall({
      ...(ask.dog ? { dog: ask.dog } : {}), query: ask.query, chats: [...ask.chats], limit: ask.limit, ...(ask.range ? { range: ask.range } : {}), ...(ask.mode ? { mode: ask.mode } : {}),
    }), ask.limit);
  }

  async recent(ask: RecentAsk, local: () => Promise<IndexRecallHit[]>): Promise<IndexRecallHit[]> {
    return this.answer("recent", ask.dog ?? PERSON_TARGET, ask.chats, local, (client) => client.recent({
      ...(ask.dog ? { dog: ask.dog } : {}), chats: [...ask.chats], limit: ask.limit, range: ask.range,
    }), ask.limit);
  }

  async memory(ask: MemoryAsk, local: () => Promise<LocalMemoryHit[][]>): Promise<LocalMemoryHit[][]> {
    const target = ask.shard ?? PERSON_TARGET;
    const chats = ask.dogs.map((dog) => `${MEMORY_CHAT}${dog}`);
    const remote = async (client: SearchIndexClient) => {
      const hits = await client.memory({
        ...(ask.shard ? { dog: ask.shard } : {}), query: ask.query, dogs: [...ask.dogs], limit: ask.limit, each: true, ...(ask.mode ? { mode: ask.mode } : {}),
      });
      return hits && ask.dogs.map((dog) => hits.filter((hit) => hit.dog === dog).map(({ file, snippet, at }) => ({ file, snippet, at })));
    };
    if (this.modeNow === "remote" && this.ready(chats, target)) {
      const found = await this.timed("memory", remote(this.deps.client));
      if (found) {
        this.remote.answered += 1;
        return found;
      }
      this.remote.fellBack += 1;
    }
    const window = this.window(chats);
    const answer = await local();
    if (this.modeNow === "shadow") this.check(this.compareMemory(ask, target, chats, answer, remote, window));
    return answer;
  }

  private async answer(op: "recall" | "recent", target: string, chats: readonly string[], local: () => Promise<IndexRecallHit[]>, remote: (client: SearchIndexClient) => Promise<IndexRecallHit[] | null>, limit: number): Promise<IndexRecallHit[]> {
    if (this.modeNow === "remote" && this.ready(chats, target)) {
      const found = await this.timed(op, remote(this.deps.client));
      if (found) {
        this.remote.answered += 1;
        return found;
      }
      this.remote.fellBack += 1;
    }
    const window = this.window(chats);
    const answer = await local();
    if (this.modeNow === "shadow") this.check(this.compareMessages(op, target, chats, answer, remote, limit, window));
    return answer;
  }

  private async compareMessages(op: string, target: string, chats: readonly string[], local: IndexRecallHit[], remote: (client: SearchIndexClient) => Promise<IndexRecallHit[] | null>, limit: number, window: ShadowWindow): Promise<void> {
    try {
      if (!this.ready(chats, target, false)) return this.count("skipped");
      const found = await this.timed(`shadow ${op}`, remote(this.shadowClient));
      if (!found) return this.count("unavailable");
      const unsettled = this.unsettled(window);
      if (unsettled.size === chats.length) return this.count("skipped");
      const stable = (hit: IndexRecallHit) => !unsettled.has(hit.threadId);
      const shard = target === PERSON_TARGET ? undefined : target;
      const outcome = await judge({
        localCount: local.length,
        remoteCount: found.length,
        local: local.filter(stable).map((hit) => ({ key: `${hit.threadId}\n${hit.messageId}`, snippet: hit.snippet, extra: `${hit.from ?? ""}|${hit.peer ?? ""}|${hit.kind ?? ""}|${hit.at}` })),
        remote: found.filter(stable).map((hit) => ({ key: `${hit.threadId}\n${hit.messageId}`, snippet: hit.snippet, extra: `${hit.from ?? ""}|${hit.peer ?? ""}|${hit.kind ?? ""}|${hit.at}` })),
        limit,
        localSums: async (keys) => {
          const [rows] = await this.deps.read([messagesByKeys(keys.map(splitKey).map(([chat, id]) => ({ chat, id })))]) as [MessageRow[]];
          return new Map(rows.map((row) => [`${row.thread_id}\n${row.id}`, messageSum(row)]));
        },
        remoteSums: async (keys) => {
          const held = await this.shadowClient.has({ ...(shard ? { dog: shard } : {}), messages: keys.map(splitKey).map(([chat, id]) => ({ chat, id })) });
          return held && new Map(held.messages.map((row) => [`${row.chat}\n${row.id}`, row.sum]));
        },
      });
      this.count(outcome.outcome, outcome.outcome === "mismatch" ? { op, shard: shard ? "dog" : "person", ...outcome.detail } : undefined);
    } catch (error) {
      this.deps.log(`search-index: shadow ${op} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.count("unavailable");
    }
  }

  private async compareMemory(ask: MemoryAsk, target: string, chats: readonly string[], local: LocalMemoryHit[][], remote: (client: SearchIndexClient) => Promise<LocalMemoryHit[][] | null>, window: ShadowWindow): Promise<void> {
    try {
      if (!this.ready(chats, target, false)) return this.count("skipped");
      const found = await this.timed("shadow memory", remote(this.shadowClient));
      if (!found) return this.count("unavailable");
      const unsettled = this.unsettled(window);
      if (unsettled.size === chats.length) return this.count("skipped");
      const shard = target === PERSON_TARGET ? undefined : target;
      const stableDogs = [...ask.dogs.entries()].filter(([, dog]) => !unsettled.has(`${MEMORY_CHAT}${dog}`));
      for (const [index, [at, dog]] of stableDogs.entries()) {
        const outcome = await judge({
          localCount: (local[at] ?? []).length,
          remoteCount: (found[at] ?? []).length,
          local: (local[at] ?? []).map((hit) => ({ key: `${dog}\n${hit.file}`, snippet: hit.snippet, extra: String(hit.at) })),
          remote: (found[at] ?? []).map((hit) => ({ key: `${dog}\n${hit.file}`, snippet: hit.snippet, extra: String(hit.at) })),
          limit: ask.limit,
          localSums: async (keys) => {
            const [rows] = await this.deps.read([memoryByKeys(keys.map(splitKey).map(([owner, path]) => ({ dog: owner, path })))]) as [MemoryRow[]];
            return new Map(rows.map((row) => [`${row.bot_id}\n${row.path}`, memorySum(row)]));
          },
          remoteSums: async (keys) => {
            const held = await this.shadowClient.has({ ...(shard ? { dog: shard } : {}), memory: keys.map(splitKey).map(([owner, path]) => ({ dog: owner, path })) });
            return held && new Map(held.memory.map((row) => [`${row.dog}\n${row.path}`, row.sum]));
          },
        });
        if (outcome.outcome !== "same" || index === stableDogs.length - 1) {
          this.count(outcome.outcome, outcome.outcome === "mismatch" ? { op: "memory", shard: shard ? "dog" : "person", ...outcome.detail } : undefined);
          if (outcome.outcome !== "same") return;
        }
      }
      if (!stableDogs.length) this.count("same");
    } catch (error) {
      this.deps.log(`search-index: shadow memory failed: ${error instanceof Error ? error.message : String(error)}`);
      this.count("unavailable");
    }
  }

  async promptMemory(dog: string, snapshot: Promise<ReadonlyMap<string, string> | null> | null): Promise<ReadonlyMap<string, string>> {
    if (snapshot) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROMPT_SNAPSHOT_WAIT_MS); });
      const docs = await Promise.race([snapshot.catch(() => null), late]).finally(() => clearTimeout(timer));
      if (docs) {
        this.prompt.snapshot += 1;
        return docs;
      }
    }
    this.prompt.mountReadsAvoided += 1;
    const chat = `${MEMORY_CHAT}${dog}`;
    if (this.ready([chat], dog)) {
      const started = performance.now();
      const files = await this.deps.client.files({ dog, dogs: [dog] });
      if (files) {
        this.time("files", performance.now() - started);
        this.prompt.index += 1;
        return new Map(files.map((file) => [file.path, file.text]));
      }
    }
    try {
      const [rows] = await this.deps.read([memoryTexts(dog)]) as [Array<{ path: string; text: string }>];
      this.prompt.local += 1;
      return new Map(rows.map((row) => [row.path, row.text]));
    } catch (error) {
      this.deps.log(`search-index: memory for ${dog}'s prompt could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return new Map();
    }
  }

  noteMountRead(dog: string, parts: readonly string[]): void {
    if (this.modeNow !== "shadow" || !parts.length) return;
    this.prompt.shadowMountReads += 1;
    this.deps.log(`search-index: shadow prompt for ${dog} read ${parts.join(" and ")} from the dog's folder on the main thread`);
  }

  private check(work: Promise<void>): void {
    this.checks.add(work);
    void work.finally(() => this.checks.delete(work));
  }

  async settled(): Promise<void> {
    for (;;) {
      if (!this.feed) return;
      if (this.backfilling) await this.backfilling;
      await this.feed?.drained();
      await Promise.all(this.checks);
      if (!this.backfilling && !this.checks.size && !(this.feed?.size ?? 0) && !this.queued.size) return;
    }
  }

  status(): SearchIndexStatus {
    return {
      mode: this.modeNow,
      feed: { ...(this.feed?.state ?? { pending: 0, sent: 0, failures: 0, dropped: 0, lastError: null }), failing: this.feed?.failing ?? false },
      backfill: {
        running: this.backfilling !== null,
        chatsCovered: [...this.covered.values()].filter((targets) => targets.size).length,
        chatsQueued: this.queued.size,
        lastScanAt: this.lastScanAt,
        current: this.current,
      },
      shadow: { ...this.shadow, samples: [...this.shadow.samples] },
      remote: { ...this.remote },
      prompt: { ...this.prompt },
      timings: Object.fromEntries([...this.timings].map(([op, list]) => [op, { n: list.length, p50: percentile(list, 0.5), p95: percentile(list, 0.95) }])),
    };
  }
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf("\n");
  return [key.slice(0, at), key.slice(at + 1)];
}

interface ShadowWindow {
  marks: Map<string, number>;
  busy: Set<string>;
}

export interface JudgeInput {
  localCount?: number;
  remoteCount?: number;
  local: ReadonlyArray<{ key: string; snippet: string; extra: string }>;
  remote: ReadonlyArray<{ key: string; snippet: string; extra: string }>;
  limit: number;
  localSums(keys: string[]): Promise<Map<string, string>>;
  remoteSums(keys: string[]): Promise<Map<string, string> | null>;
}

export async function judge(input: JudgeInput): Promise<{ outcome: "same" | "ranked" | "mismatch" | "unavailable"; detail: Record<string, unknown> }> {
  const localKeys = new Set(input.local.map((hit) => hit.key));
  const remoteKeys = new Set(input.remote.map((hit) => hit.key));
  const onlyLocal = [...localKeys].filter((key) => !remoteKeys.has(key));
  const onlyRemote = [...remoteKeys].filter((key) => !localKeys.has(key));
  const sameOrder = !onlyLocal.length && !onlyRemote.length && input.local.map((hit) => hit.key).join("\0") === input.remote.map((hit) => hit.key).join("\0");
  const remoteBy = new Map(input.remote.map((hit) => [hit.key, hit]));
  const changed = input.local.filter((hit) => remoteBy.has(hit.key) && (remoteBy.get(hit.key)!.snippet !== hit.snippet || remoteBy.get(hit.key)!.extra !== hit.extra)).map((hit) => hit.key);
  if (changed.length) return { outcome: "mismatch", detail: { reason: "content", keys: changed.slice(0, 5).map(hidden) } };
  if (sameOrder) return { outcome: "same", detail: {} };
  const localTruncated = (input.localCount ?? input.local.length) >= input.limit;
  const remoteTruncated = (input.remoteCount ?? input.remote.length) >= input.limit;
  if (onlyRemote.length && !localTruncated) return { outcome: "mismatch", detail: { reason: "extra", keys: onlyRemote.slice(0, 5).map(hidden) } };
  if (onlyLocal.length && !remoteTruncated) return { outcome: "mismatch", detail: { reason: "missing", keys: onlyLocal.slice(0, 5).map(hidden) } };
  const [localSums, remoteSums] = await Promise.all([input.localSums([...onlyLocal, ...onlyRemote]), input.remoteSums([...onlyLocal, ...onlyRemote])]);
  if (!remoteSums) return { outcome: "unavailable", detail: {} };
  const stale = [...onlyLocal, ...onlyRemote].filter((key) => !localSums.has(key) || localSums.get(key) !== remoteSums.get(key));
  if (stale.length) return { outcome: "mismatch", detail: { reason: "stale", keys: stale.slice(0, 5).map(hidden) } };
  return { outcome: "ranked", detail: {} };
}

function hidden(key: string): string {
  const [left, right] = splitKey(key);
  return `${left.slice(0, 8)}/${right.slice(0, 8)}`;
}
