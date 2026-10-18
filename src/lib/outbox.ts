import { SEND_DELIVERIES, type SendDelivery } from "../../shared/send-delivery";

const isSendDelivery = (value: unknown): value is SendDelivery => (SEND_DELIVERIES as readonly unknown[]).includes(value);

export type OutboxTarget =
  | { kind: "bot"; botId: string; deliver?: SendDelivery }
  | { kind: "group"; groupId: string; mode: "chat" | "goal" };

export interface OutboxRecovery {
  draftId: string;
  text: string;
  channelMode?: "chat" | "goal";
}

export interface OutboxItem {
  sendId: string;
  threadId: string;
  target: OutboxTarget;
  text: string;
  replyToId?: string;
  queuedAt: number;
  recovery?: OutboxRecovery;
}

export type SendOutcome = { kind: "hold"; afterMs?: number } | { kind: "retry" } | { kind: "final" };

export const OUTBOX_KEY = "laterdog-outbox";
export const OUTBOX_VERSION = 1;
export const SEND_ATTEMPT_TIMEOUT_MS = 90_000;
export const MAX_SERVER_FAILURES = 5;
export const HOLD_CAP_MS = 15_000;
export const PROGRESS_AFTER_MS = 2_000;

const GATEWAY = new Set([502, 503, 504]);

export function sendOutcome(error: unknown): SendOutcome {
  if (error instanceof TypeError) return { kind: "hold" };
  const failure = (error ?? {}) as { name?: unknown; status?: unknown; wake?: unknown; retryAfterMs?: unknown };
  if (failure.name === "TimeoutError") return { kind: "hold" };
  const afterMs = typeof failure.retryAfterMs === "number" && failure.retryAfterMs > 0 ? failure.retryAfterMs : undefined;
  if (typeof failure.wake === "string") return { kind: "hold", afterMs };
  if (typeof failure.status !== "number") return { kind: "final" };
  if (GATEWAY.has(failure.status) || failure.status === 408 || failure.status === 429) return { kind: "hold", afterMs };
  if (failure.status >= 500) return { kind: "retry" };
  return { kind: "final" };
}

export function laneKey(item: OutboxItem): string {
  return item.threadId || (item.target.kind === "bot" ? `bot:${item.target.botId}` : `group:${item.target.groupId}`);
}

export function holdDelay(attempt: number): number {
  return Math.min(HOLD_CAP_MS, 2_000 * 2 ** Math.max(0, attempt - 1));
}

export interface OutboxOptions {
  attempt(item: OutboxItem): Promise<void>;
  save(items: readonly OutboxItem[]): void;
  onFinal(item: OutboxItem, error: unknown): void;
  after?(ms: number, run: () => void): () => void;
}

export interface Outbox {
  enqueue(item: OutboxItem): void;
  restore(items: readonly OutboxItem[]): void;
  resume(): void;
  acknowledge(sendId: string): void;
  items(): OutboxItem[];
  dispose(): void;
}

interface Lane {
  items: OutboxItem[];
  pumping: boolean;
  holds: number;
  failures: number;
  cancel: (() => void) | null;
}

function defaultAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export function createOutbox(options: OutboxOptions): Outbox {
  const after = options.after ?? defaultAfter;
  const lanes = new Map<string, Lane>();
  let disposed = false;

  const all = () => [...lanes.values()].flatMap((lane) => lane.items).sort((a, b) => a.queuedAt - b.queuedAt);
  const save = () => options.save(all());
  const laneFor = (threadId: string) => {
    const existing = lanes.get(threadId);
    if (existing) return existing;
    const lane: Lane = { items: [], pumping: false, holds: 0, failures: 0, cancel: null };
    lanes.set(threadId, lane);
    return lane;
  };
  const stopTimer = (lane: Lane) => {
    lane.cancel?.();
    lane.cancel = null;
  };
  const drop = (threadId: string, sendId: string): boolean => {
    const lane = lanes.get(threadId);
    if (!lane || !lane.items.some((item) => item.sendId === sendId)) return false;
    const wasHead = lane.items[0]?.sendId === sendId;
    lane.items = lane.items.filter((item) => item.sendId !== sendId);
    if (wasHead) {
      lane.holds = 0;
      lane.failures = 0;
    }
    if (lane.items.length === 0 && !lane.pumping) {
      stopTimer(lane);
      lanes.delete(threadId);
    }
    save();
    return true;
  };
  const schedule = (threadId: string, lane: Lane, ms: number) => {
    stopTimer(lane);
    lane.cancel = after(ms, () => {
      lane.cancel = null;
      void pump(threadId);
    });
  };

  async function pump(threadId: string): Promise<void> {
    const lane = lanes.get(threadId);
    if (!lane || lane.pumping || disposed) return;
    lane.pumping = true;
    stopTimer(lane);
    try {
      while (!disposed && lane.items.length > 0) {
        const head = lane.items[0]!;
        try {
          await options.attempt(head);
        } catch (error) {
          if (disposed) return;
          if (lane.items[0]?.sendId !== head.sendId) continue;
          const outcome = sendOutcome(error);
          if (outcome.kind === "hold") {
            lane.holds += 1;
            schedule(threadId, lane, outcome.afterMs ?? holdDelay(lane.holds));
            return;
          }
          if (outcome.kind === "retry" && lane.failures + 1 < MAX_SERVER_FAILURES) {
            lane.failures += 1;
            schedule(threadId, lane, holdDelay(lane.failures));
            return;
          }
          drop(threadId, head.sendId);
          options.onFinal(head, error);
          continue;
        }
        if (disposed) return;
        drop(threadId, head.sendId);
      }
    } finally {
      lane.pumping = false;
      if (lane.items.length === 0 && lanes.get(threadId) === lane) {
        stopTimer(lane);
        lanes.delete(threadId);
      }
    }
  }

  return {
    enqueue(item) {
      if (disposed || all().some((queued) => queued.sendId === item.sendId)) return;
      laneFor(laneKey(item)).items.push(item);
      save();
      void pump(laneKey(item));
    },
    restore(items) {
      for (const item of items) {
        if (all().some((queued) => queued.sendId === item.sendId)) continue;
        laneFor(laneKey(item)).items.push(item);
      }
      for (const lane of lanes.values()) lane.items.sort((a, b) => a.queuedAt - b.queuedAt);
    },
    resume() {
      for (const threadId of lanes.keys()) void pump(threadId);
    },
    acknowledge(sendId) {
      for (const [threadId, lane] of lanes) {
        const head = lane.items[0]?.sendId === sendId;
        if (!drop(threadId, sendId)) continue;
        if (head && !lane.pumping) void pump(threadId);
        return;
      }
    },
    items: all,
    dispose() {
      disposed = true;
      for (const lane of lanes.values()) stopTimer(lane);
    },
  };
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readTarget(value: unknown): OutboxTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "bot" && isText(value.botId)) {
    return isSendDelivery(value.deliver) ? { kind: "bot", botId: value.botId, deliver: value.deliver } : { kind: "bot", botId: value.botId };
  }
  if (value.kind === "group" && isText(value.groupId)) {
    return { kind: "group", groupId: value.groupId, mode: value.mode === "goal" ? "goal" : "chat" };
  }
  return null;
}

function readRecovery(value: unknown): OutboxRecovery | undefined {
  if (!isRecord(value) || !isText(value.draftId) || typeof value.text !== "string") return undefined;
  return {
    draftId: value.draftId,
    text: value.text,
    ...(value.channelMode === "chat" || value.channelMode === "goal" ? { channelMode: value.channelMode } : {}),
  };
}

function readItem(value: unknown): OutboxItem | null {
  if (!isRecord(value) || !isText(value.sendId) || !isText(value.threadId) || typeof value.text !== "string") return null;
  const target = readTarget(value.target);
  if (!target) return null;
  const recovery = readRecovery(value.recovery);
  return {
    sendId: value.sendId,
    threadId: value.threadId,
    target,
    text: value.text,
    ...(isText(value.replyToId) ? { replyToId: value.replyToId } : {}),
    queuedAt: typeof value.queuedAt === "number" && Number.isFinite(value.queuedAt) ? value.queuedAt : Date.now(),
    ...(recovery ? { recovery } : {}),
  };
}

export function parseOutbox(raw: string | null | undefined): OutboxItem[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== OUTBOX_VERSION || !Array.isArray(value.items)) return [];
    return value.items.map(readItem).filter((item): item is OutboxItem => item !== null);
  } catch {
    return [];
  }
}

export function readOutbox(store: Store): OutboxItem[] {
  try {
    return parseOutbox(store?.getItem(OUTBOX_KEY));
  } catch {
    return [];
  }
}

export function writeOutbox(store: Store, items: readonly OutboxItem[]): void {
  try {
    if (items.length === 0) store?.removeItem(OUTBOX_KEY);
    else store?.setItem(OUTBOX_KEY, JSON.stringify({ version: OUTBOX_VERSION, items }));
  } catch {}
}

export function browserStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
