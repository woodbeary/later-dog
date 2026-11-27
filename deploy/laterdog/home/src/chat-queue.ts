import { DurableObject } from "cloudflare:workers";

export const QUEUE_ROW_STATUSES = ["accepted", "pending", "dispatching", "interrupted", "cancelled"] as const;
export type QueueRowStatus = (typeof QUEUE_ROW_STATUSES)[number];
export const CANCELLED_KEPT_MS = 7 * 24 * 60 * 60_000;
export const MAX_QUEUE_ROWS = 500;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface QueueRow {
  id: string;
  sendId: string | null;
  status: QueueRowStatus;
  payload: unknown;
  at: number;
}

export interface QueueRowInput {
  id: string;
  sendId?: string | null;
  status: QueueRowStatus;
  payload: unknown;
  at: number;
}

export const MAX_HISTORY_MESSAGE_BYTES = 256 * 1024;

export interface HistoryRow {
  id: string;
  at: number;
  json: string;
}

export function validHistoryRow(value: unknown): value is HistoryRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && ID.test(row.id) && typeof row.at === "number" && Number.isSafeInteger(row.at) &&
    typeof row.json === "string" && row.json.length <= MAX_HISTORY_MESSAGE_BYTES;
}

export interface ChatHistoryPort {
  append(rows: HistoryRow[]): Promise<number>;
  page(after: string | null, limit: number): Promise<{ rows: HistoryRow[]; count: number }>;
}

export function chatHistory(sql: Sql): ChatHistoryPort {
  sql.exec(`CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS history_at ON history (at, id)");
  return {
    async append(rows) {
      let stored = 0;
      for (const row of rows) {
        if (!validHistoryRow(row)) continue;
        sql.exec("INSERT INTO history (id, at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json", row.id, row.at, row.json);
        stored += 1;
      }
      return stored;
    },
    async page(after, limit) {
      const size = Math.max(1, Math.min(500, Math.floor(limit)));
      const anchor = after ? sql.exec("SELECT at FROM history WHERE id = ?", after).toArray()[0] : undefined;
      const rows = (anchor
        ? sql.exec("SELECT id, at, json FROM history WHERE at > ? OR (at = ? AND id > ?) ORDER BY at, id LIMIT ?", anchor.at, anchor.at, after, size)
        : sql.exec("SELECT id, at, json FROM history ORDER BY at, id LIMIT ?", size)).toArray()
        .map((row) => ({ id: String(row.id), at: Number(row.at), json: String(row.json) }));
      const count = Number(sql.exec("SELECT COUNT(*) AS n FROM history").toArray()[0]?.n ?? 0);
      return { rows, count };
    },
  };
}

export interface ChatQueuePort {
  put(rows: QueueRowInput[]): Promise<number>;
  settle(ids: string[], status: QueueRowStatus | null): Promise<number>;
  release(before: number): Promise<number>;
  rows(): Promise<QueueRow[]>;
}

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const ID = /^[\w:.-]{1,160}$/;

export function validQueueRow(value: unknown): value is QueueRowInput {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && ID.test(row.id) &&
    (row.sendId === undefined || row.sendId === null || (typeof row.sendId === "string" && row.sendId.length <= 200)) &&
    (QUEUE_ROW_STATUSES as readonly unknown[]).includes(row.status) &&
    typeof row.at === "number" && Number.isSafeInteger(row.at) &&
    JSON.stringify(row.payload ?? null).length <= MAX_PAYLOAD_BYTES;
}

export function chatQueue(sql: Sql, now: () => number = Date.now): ChatQueuePort {
  sql.exec(`CREATE TABLE IF NOT EXISTS queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    send_id TEXT,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    at INTEGER NOT NULL,
    changed INTEGER NOT NULL
  )`);
  const prune = () => sql.exec("DELETE FROM queue WHERE status = 'cancelled' AND changed < ?", now() - CANCELLED_KEPT_MS);
  return {
    async put(rows) {
      let stored = 0;
      for (const row of rows) {
        if (!validQueueRow(row)) continue;
        const held = sql.exec("SELECT status FROM queue WHERE id = ?", row.id).toArray()[0];
        if (held) {
          sql.exec("UPDATE queue SET status = ?, changed = ? WHERE id = ?", row.status, now(), row.id);
        } else {
          const count = Number(sql.exec("SELECT COUNT(*) AS n FROM queue WHERE status != 'cancelled'").toArray()[0]?.n ?? 0);
          if (count >= MAX_QUEUE_ROWS) throw new Error("queue_full");
          sql.exec("INSERT INTO queue (id, send_id, status, payload, at, changed) VALUES (?, ?, ?, ?, ?, ?)",
            row.id, row.sendId ?? null, row.status, JSON.stringify(row.payload ?? null), row.at, now());
        }
        stored += 1;
      }
      prune();
      return stored;
    },
    async settle(ids, status) {
      let changed = 0;
      for (const id of ids) {
        if (typeof id !== "string" || !ID.test(id)) continue;
        if (status === null) sql.exec("DELETE FROM queue WHERE id = ?", id);
        else sql.exec("UPDATE queue SET status = ?, changed = ? WHERE id = ?", status, now(), id);
        changed += 1;
      }
      return changed;
    },
    async release(before) {
      const rows = sql.exec("SELECT id FROM queue WHERE status IN ('accepted', 'dispatching') AND at <= ?", before).toArray();
      sql.exec("DELETE FROM queue WHERE status IN ('accepted', 'dispatching') AND at <= ?", before);
      return rows.length;
    },
    async rows() {
      return sql.exec("SELECT id, send_id, status, payload, at FROM queue ORDER BY seq").toArray().map((row) => ({
        id: String(row.id),
        sendId: row.send_id === null ? null : String(row.send_id),
        status: row.status as QueueRowStatus,
        payload: JSON.parse(String(row.payload)) as unknown,
        at: Number(row.at),
      }));
    },
  };
}

export class ChatQueue extends DurableObject implements ChatQueuePort, ChatHistoryPort {
  private readonly queue = chatQueue(this.ctx.storage.sql);
  private readonly history = chatHistory(this.ctx.storage.sql);
  append(rows: HistoryRow[]) {
    return this.history.append(rows);
  }
  page(after: string | null, limit: number) {
    return this.history.page(after, limit);
  }
  put(rows: QueueRowInput[]) {
    return this.queue.put(rows);
  }
  settle(ids: string[], status: QueueRowStatus | null) {
    return this.queue.settle(ids, status);
  }
  release(before: number) {
    return this.queue.release(before);
  }
  rows() {
    return this.queue.rows();
  }
}

export interface DogSlot {
  chat: string;
  since: number;
  planned?: boolean;
}

export interface DogSlotsPort {
  slots(): Promise<DogSlot[]>;
  setSlots(slots: DogSlot[]): Promise<string[]>;
  chats(): Promise<string[]>;
  noteChat(chat: string, queued: boolean): Promise<void>;
}

interface KeyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export function validSlot(value: unknown): value is DogSlot {
  const slot = value as Partial<DogSlot> | null;
  return Boolean(slot) && typeof slot!.chat === "string" && ID.test(slot!.chat) && typeof slot!.since === "number" &&
    (slot!.planned === undefined || typeof slot!.planned === "boolean");
}

export function dogSlots(storage: KeyStorage): DogSlotsPort {
  return {
    async slots() {
      return (await storage.get<DogSlot[]>("slots")) ?? [];
    },
    async setSlots(slots) {
      const before = (await storage.get<DogSlot[]>("slots")) ?? [];
      const next = slots.filter(validSlot);
      await storage.put("slots", next);
      const still = new Set(next.map((slot) => slot.chat));
      return before.filter((slot) => !still.has(slot.chat)).map((slot) => slot.chat);
    },
    async chats() {
      return (await storage.get<string[]>("queued-chats")) ?? [];
    },
    async noteChat(chat, queued) {
      const held = new Set((await storage.get<string[]>("queued-chats")) ?? []);
      if (queued === held.has(chat)) return;
      if (queued) held.add(chat);
      else held.delete(chat);
      await storage.put("queued-chats", [...held]);
    },
  };
}
