import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";

export const QUEUE_ROUTE = "/api/internal/coordinator/queue";
export const RESTORE_BUDGET_MS = 4_000;
const CALL_MS = 10_000;
const TOKEN_MS = 10 * 60_000;
const MAX_WAITING = 1_000;
const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type ObjectRowStatus = "accepted" | "pending" | "dispatching" | "interrupted" | "cancelled";

export interface ObjectRow {
  id: string;
  sendId?: string | null;
  status: ObjectRowStatus;
  payload: unknown;
  at: number;
}

export interface ObjectSlot {
  chat: string;
  since: number;
  planned?: boolean;
}

export interface RestoredQueue {
  slots: ObjectSlot[];
  chats: Record<string, Array<ObjectRow & { sendId: string | null }>>;
}

export interface ObjectQueueOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

type Op =
  | { op: "put"; rows: ObjectRow[] }
  | { op: "settle"; ids: string[]; status: ObjectRowStatus | null }
  | { op: "slots"; slots: ObjectSlot[]; at: number }
  | { op: "restore" };

interface Waiting {
  chat: string;
  body: Op;
}

export class ObjectQueue {
  private readonly secret: Buffer;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly waiting = new Map<string, Waiting[]>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  readonly state = { sent: 0, failures: 0, dropped: 0, lastError: null as string | null };

  private readonly options: ObjectQueueOptions;

  constructor(options: ObjectQueueOptions) {
    this.options = options;
    this.secret = capabilitySecret(options.bootstrapSecret);
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.log = options.log ?? ((line) => console.warn(line));
  }

  put(dog: string, chat: string, rows: ObjectRow[]): void {
    this.later(dog, chat, { op: "put", rows });
  }

  settle(dog: string, chat: string, ids: string[], status: ObjectRowStatus | null): void {
    if (ids.length) this.later(dog, chat, { op: "settle", ids, status });
  }

  slots(dog: string, slots: ObjectSlot[]): void {
    this.later(dog, "dog", { op: "slots", slots, at: this.now() });
  }

  pending(): number {
    let count = 0;
    for (const list of this.waiting.values()) count += list.length;
    return count;
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  async restore(dog: string, budgetMs = RESTORE_BUDGET_MS): Promise<RestoredQueue | null> {
    await Promise.race([this.running.get(dog) ?? Promise.resolve(), this.wait(budgetMs)]);
    try {
      const answer = await this.call(dog, "dog", { op: "restore" }, Math.min(budgetMs, CALL_MS));
      return { slots: Array.isArray(answer.slots) ? answer.slots as ObjectSlot[] : [], chats: (answer.chats ?? {}) as RestoredQueue["chats"] };
    } catch (error) {
      this.log(`[object queue] restore for ${dog} failed: ${(error as Error).message}`);
      return null;
    }
  }

  private later(dog: string, chat: string, body: Op): void {
    const list = this.waiting.get(dog) ?? [];
    if (list.length >= MAX_WAITING) {
      list.shift();
      this.state.dropped += 1;
    }
    list.push({ chat, body });
    this.waiting.set(dog, list);
    if (!this.running.has(dog)) {
      const run = this.drain(dog).finally(() => this.running.delete(dog));
      this.running.set(dog, run);
    }
  }

  private async drain(dog: string): Promise<void> {
    const list = this.waiting.get(dog);
    let attempt = 0;
    while (list?.length) {
      const next = list[0]!;
      try {
        await this.call(dog, next.chat, next.body, CALL_MS);
        list.shift();
        this.state.sent += 1;
        attempt = 0;
      } catch (error) {
        this.state.failures += 1;
        this.state.lastError = (error as Error).message;
        if ((error as { status?: number }).status === 400) {
          list.shift();
          this.state.dropped += 1;
          this.log(`[object queue] ${next.body.op} for ${dog} refused: ${(error as Error).message}`);
          continue;
        }
        await this.wait(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
        attempt += 1;
      }
    }
    if (list && !list.length) this.waiting.delete(dog);
  }

  private bearer(dog: string, chat: string): string {
    const key = `${dog} ${chat}`;
    const at = this.now();
    const held = this.tokens.get(key);
    if (held && held.expiresAt - at > 60_000) return held.value;
    const value = signCapabilitySync(this.secret, { home: this.options.home, dog, chat, generation: "queue", kind: "turns", issuedAt: at, expiresAt: at + TOKEN_MS });
    this.tokens.set(key, { value, expiresAt: at + TOKEN_MS });
    return value;
  }

  private async call(dog: string, chat: string, body: Op, budgetMs: number): Promise<Record<string, unknown>> {
    const response = await this.send(`${this.options.origin}${QUEUE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearer(dog, chat)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budgetMs),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || answer.ok !== true) {
      throw Object.assign(new Error(`queue ${body.op} answered ${response.status} ${String(answer.error ?? "")}`.trim()), { status: response.status });
    }
    return answer;
  }
}

export interface LocalChatView {
  owned: boolean;
  delivered(row: { id: string; sendId: string | null }): boolean;
  localStatus(id: string): "pending" | "dispatching" | "interrupted" | "cancelled" | null;
}

export type RowAction =
  | { kind: "keep" }
  | { kind: "drop"; status: ObjectRowStatus | null }
  | { kind: "cancel-here" }
  | { kind: "requeue" };

export function reconcileRow(row: { id: string; sendId: string | null; status: ObjectRowStatus }, local: LocalChatView): RowAction {
  const here = local.localStatus(row.id);
  if (row.status === "cancelled") return here === "pending" ? { kind: "cancel-here" } : { kind: "keep" };
  if (!local.owned) return { kind: "drop", status: "cancelled" };
  if (local.delivered(row)) return { kind: "drop", status: null };
  if (here === "pending") return { kind: "keep" };
  if (here === "cancelled") return { kind: "drop", status: "cancelled" };
  return { kind: "requeue" };
}

export function slotsByDog(turns: ReadonlyArray<{ botId: string; threadId: string; since: number; planned?: boolean }>): Map<string, ObjectSlot[]> {
  const byDog = new Map<string, ObjectSlot[]>();
  for (const turn of turns) {
    const list = byDog.get(turn.botId) ?? [];
    list.push({ chat: turn.threadId, since: turn.since, ...(turn.planned ? { planned: true } : {}) });
    byDog.set(turn.botId, list);
  }
  return byDog;
}
