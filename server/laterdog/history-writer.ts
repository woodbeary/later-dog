import type { DatabaseSync } from "node:sqlite";
import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";
import {
  chatsAwaitingClear,
  coveredHistory,
  fillFromObject,
  localHistoryPage,
  localOnlyRows,
  localHistoryStats,
  localHistoryThreads,
  markCovered,
  outboxSize,
  settleOutbox,
  takeOutbox,
  type OutboxChat,
} from "./history-outbox-db.ts";
import { HISTORY_BATCH_BYTES, HISTORY_PAGE_MAX, HISTORY_ROUTE, MAX_HISTORY_MESSAGE_BYTES, historyIdOk, jsonBytes, type HistoryChange, type HistoryPage, type HistoryStats } from "../../shared/history-object.ts";

export const HISTORY_MODES = ["off", "shadow", "object-writer"] as const;
export type HistoryMode = (typeof HISTORY_MODES)[number];

const FLUSH_MS = 300;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const CALL_MS = 20_000;
const TOKEN_MS = 10 * 60_000;
const FLUSH_CHATS = 16;
const FLUSH_MESSAGES = 200;
const PARALLEL = 4;
const RECONCILE_PAGE = 200;
const ENSURE_MS = 5_000;

export interface HistoryDatabase {
  read<T>(read: (database: DatabaseSync) => T): T;
  write<T>(write: (database: DatabaseSync) => T): T;
}

export interface HistoryWriterOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  database: HistoryDatabase;
  keepOutbox(on: boolean): void;
  ownerOf(threadId: string): string | null;
  knownChats(): string[];
  filled?(threadId: string): void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface HistoryWriterState {
  mode: HistoryMode;
  outbox: number;
  sent: number;
  cleared: number;
  failures: number;
  oversized: number;
  covered: number;
  reconciling: number;
  filled: number;
  pushed: number;
  mismatched: string[];
  lastError: string | null;
  pass: { started: number; finished: number | null; chats: number } | null;
}

const DOG_CLAIM = /^[A-Za-z0-9_.:-]{1,128}$/;

export class HistoryWriter {
  private readonly options: HistoryWriterOptions;
  private readonly secret: Buffer;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly locked = new Map<string, Promise<boolean>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private passing: Promise<void> | null = null;
  private attempt = 0;
  private current: HistoryMode = "off";
  private readonly counts = { sent: 0, cleared: 0, failures: 0, oversized: 0, filled: 0, pushed: 0 };
  private readonly mismatched = new Set<string>();
  private lastError: string | null = null;
  private pass: HistoryWriterState["pass"] = null;

  constructor(options: HistoryWriterOptions) {
    this.options = options;
    this.secret = capabilitySecret(options.bootstrapSecret);
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  get mode(): HistoryMode {
    return this.current;
  }

  get objectIsRecord(): boolean {
    return this.current === "object-writer";
  }

  setMode(mode: HistoryMode): void {
    const before = this.current;
    this.current = mode;
    this.options.keepOutbox(mode !== "off");
    if (mode === "off") {
      if (before === "object-writer") void this.reconcileAll("reverse");
      return;
    }
    this.wake();
    if (before !== mode) void this.reconcileAll(mode === "object-writer" ? "record" : "copy");
  }

  state(): HistoryWriterState {
    const db = this.options.database;
    return {
      mode: this.current,
      outbox: db.read(outboxSize),
      ...this.counts,
      covered: db.read(coveredHistory).size,
      reconciling: this.locked.size,
      mismatched: [...this.mismatched].slice(0, 20),
      lastError: this.lastError,
      pass: this.pass,
    };
  }

  wake(): void {
    if (this.current === "off" || this.timer || this.flushing) return;
    const delay = this.attempt ? RETRY_MS[Math.min(this.attempt - 1, RETRY_MS.length - 1)]! : FLUSH_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushing = this.flush().finally(() => {
        this.flushing = null;
        if (this.current !== "off" && this.options.database.read(outboxSize) > this.locked.size) this.wake();
      });
    }, delay);
    this.timer.unref?.();
  }

  async idle(): Promise<void> {
    for (let rounds = 0; rounds < 50; rounds += 1) {
      if (this.flushing) { await this.flushing; continue; }
      if (this.passing) { await this.passing; continue; }
      if (this.current === "off" || this.options.database.read(outboxSize) === 0) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.flush();
      if (this.attempt) return;
    }
  }

  async ensureChat(threadId: string): Promise<void> {
    if (this.current !== "object-writer" || !historyIdOk(threadId)) return;
    if (this.options.database.read(coveredHistory).has(threadId)) return;
    await Promise.race([
      this.reconcile(threadId, "record").catch(() => false),
      new Promise((resolve) => setTimeout(resolve, ENSURE_MS).unref?.()),
    ]);
  }

  async pageBefore(threadId: string, before: number | null, limit: number): Promise<HistoryPage> {
    return await this.call(threadId, { op: "before", before, limit: Math.min(limit, HISTORY_PAGE_MAX) }) as unknown as HistoryPage;
  }

  async objectStats(threadId: string): Promise<HistoryStats> {
    return await this.call(threadId, { op: "stats" }) as unknown as HistoryStats;
  }

  private async flush(): Promise<void> {
    if (this.current === "off") return;
    const batch = this.options.database.read((db) => takeOutbox(db, FLUSH_CHATS, FLUSH_MESSAGES, new Set(this.locked.keys())));
    let failed = false;
    for (let i = 0; i < batch.length; i += PARALLEL) {
      const results = await Promise.allSettled(batch.slice(i, i + PARALLEL).map((chat) => this.flushChat(chat)));
      for (const result of results) {
        if (result.status === "rejected") {
          failed = true;
          this.counts.failures += 1;
          this.lastError = (result.reason as Error).message;
        }
      }
    }
    this.attempt = failed ? this.attempt + 1 : 0;
    if (failed && this.attempt === 1) this.log(`[history] outbox send failed, retrying: ${this.lastError}`);
  }

  private async flushChat(chat: OutboxChat): Promise<void> {
    if (!historyIdOk(chat.threadId)) {
      this.options.database.write((db) => settleOutbox(db, chat));
      return;
    }
    if (chat.chat?.cleared) {
      await this.call(chat.threadId, { op: "clear" });
      this.counts.cleared += 1;
    }
    const changes: HistoryChange[] = [];
    for (const message of chat.messages) {
      if (!historyIdOk(message.id)) continue;
      if (message.json === null) changes.push({ op: "del", id: message.id });
      else if (jsonBytes(message.json) > MAX_HISTORY_MESSAGE_BYTES) this.counts.oversized += 1;
      else changes.push({ op: "put", id: message.id, at: message.at, json: message.json });
    }
    const leaf = chat.chat && !chat.chat.cleared ? { id: chat.chat.leaf } : undefined;
    await this.sendChanges(chat.threadId, changes, leaf);
    this.counts.sent += changes.length;
    this.options.database.write((db) => settleOutbox(db, chat));
  }

  private async sendChanges(threadId: string, changes: HistoryChange[], leaf?: { id: string | null }): Promise<void> {
    let part: HistoryChange[] = [];
    let bytes = 0;
    for (const change of changes) {
      const size = change.op === "put" ? jsonBytes(change.json) + 200 : 200;
      if (part.length && bytes + size > HISTORY_BATCH_BYTES) {
        await this.call(threadId, { op: "write", changes: part });
        part = [];
        bytes = 0;
      }
      part.push(change);
      bytes += size;
    }
    if (part.length || leaf) await this.call(threadId, { op: "write", changes: part, ...(leaf ? { leaf } : {}) });
  }

  async reconcileAll(kind: "copy" | "record" | "reverse"): Promise<void> {
    if (this.passing) return this.passing;
    this.passing = (async () => {
      const db = this.options.database;
      const covered = db.read(coveredHistory);
      const clearing = db.read(chatsAwaitingClear);
      const chats = [...new Set([...this.options.knownChats(), ...db.read(localHistoryThreads)])]
        .filter((id) => historyIdOk(id) && !clearing.has(id) && (kind === "reverse" || !covered.has(id)));
      this.pass = { started: this.now(), finished: null, chats: chats.length };
      this.log(`[history] ${kind} pass over ${chats.length} chat(s)`);
      let next = 0;
      const worker = async () => {
        while (next < chats.length && (this.current !== "off" || kind === "reverse")) {
          const threadId = chats[next++]!;
          await this.reconcile(threadId, kind).catch((error) => {
            this.counts.failures += 1;
            this.lastError = (error as Error).message;
            this.mismatched.add(threadId);
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      this.pass = { ...this.pass, finished: this.now() };
      this.log(`[history] ${kind} pass done: ${this.counts.pushed} pushed, ${this.counts.filled} filled, ${this.mismatched.size} mismatched`);
      if (kind === "reverse" && this.current === "off") this.options.keepOutbox(false);
    })().finally(() => { this.passing = null; });
    return this.passing;
  }

  reconcile(threadId: string, kind: "copy" | "record" | "reverse"): Promise<boolean> {
    const held = this.locked.get(threadId);
    if (held) return held;
    const run = this.reconcileChat(threadId, kind).finally(() => {
      this.locked.delete(threadId);
      this.wake();
    });
    this.locked.set(threadId, run);
    return run;
  }

  private async reconcileChat(threadId: string, kind: "copy" | "record" | "reverse"): Promise<boolean> {
    const db = this.options.database;
    let local = db.read((database) => localHistoryStats(database, threadId));
    let remote = await this.objectStats(threadId);
    if (same(local, remote)) return this.covered(threadId, local);
    if (kind !== "copy" && remote.count > 0) {
      const rows = await this.objectRows(threadId);
      const { added, replaced } = db.write((database) => fillFromObject(database, threadId, rows, remote.leaf));
      this.counts.filled += added + replaced;
      if (added || replaced) this.options.filled?.(threadId);
      local = db.read((database) => localHistoryStats(database, threadId));
      if (same(local, remote)) return this.covered(threadId, local);
      if (kind === "record") {
        const ids = new Set(rows.map((row) => row.id));
        const extra = db.read((database) => localOnlyRows(database, threadId, ids));
        await this.sendChanges(threadId, extra.filter((row) => jsonBytes(row.json) <= MAX_HISTORY_MESSAGE_BYTES)
          .map((row): HistoryChange => ({ op: "put", id: row.id, at: row.at, json: row.json })));
        this.counts.pushed += extra.length;
        remote = await this.objectStats(threadId);
        local = db.read((database) => localHistoryStats(database, threadId));
        if (same(local, remote)) return this.covered(threadId, local);
      }
    }
    if (kind === "reverse" || (kind === "record" && remote.count > 0)) {
      this.mismatched.add(threadId);
      return false;
    }
    await this.call(threadId, { op: "clear" });
    let after = Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows = db.read((database) => localHistoryPage(database, threadId, after, RECONCILE_PAGE));
      if (!rows.length) break;
      after = rows.at(-1)!.rowid;
      const changes = rows.filter((row) => historyIdOk(row.id) && jsonBytes(row.json) <= MAX_HISTORY_MESSAGE_BYTES)
        .map((row): HistoryChange => ({ op: "put", id: row.id, at: row.at, json: row.json }));
      this.counts.oversized += rows.length - changes.length;
      await this.sendChanges(threadId, changes);
      this.counts.pushed += changes.length;
    }
    local = db.read((database) => localHistoryStats(database, threadId));
    await this.call(threadId, { op: "write", changes: [], leaf: { id: local.leaf } });
    remote = await this.objectStats(threadId);
    if (same(local, remote)) return this.covered(threadId, local);
    this.mismatched.add(threadId);
    return false;
  }

  private covered(threadId: string, stats: { count: number; bytes: number }): boolean {
    this.mismatched.delete(threadId);
    this.options.database.write((database) => markCovered(database, threadId, stats, this.now()));
    return true;
  }

  private async objectRows(threadId: string): Promise<Array<{ id: string; at: number; json: string }>> {
    const rows: Array<{ id: string; at: number; json: string }> = [];
    let after = 0;
    for (;;) {
      const page = await this.call(threadId, { op: "after", after, limit: HISTORY_PAGE_MAX }) as unknown as HistoryPage;
      rows.push(...page.rows);
      if (!page.more || !page.rows.length) return rows;
      after = page.rows.at(-1)!.ord;
    }
  }

  private async call(threadId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const at = this.now();
    const owner = this.options.ownerOf(threadId);
    const dog = owner && DOG_CLAIM.test(owner) ? owner : "home";
    const token = signCapabilitySync(this.secret, { home: this.options.home, dog, chat: threadId, generation: "history", kind: "turns", issuedAt: at, expiresAt: at + TOKEN_MS });
    const response = await this.send(`${this.options.origin}${HISTORY_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!response.ok) throw new Error(`history ${String(body.op)} answered ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
}

function same(local: { count: number; bytes: number; leaf: string | null }, remote: HistoryStats): boolean {
  return local.count === remote.count && local.bytes === remote.bytes;
}

