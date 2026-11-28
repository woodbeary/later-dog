import { DOG_CHAT, type InboxLetter, type StoredLetter } from "../../shared/dog-object-protocol.ts";
import type { DogObjectCalls } from "./object-routines.ts";

const RETRY_MS = [500, 2_000, 5_000, 15_000, 30_000] as const;
const POLL_MS = 30_000;
export const REDELIVER_WITHIN_MS = 6 * 60 * 60_000;
export type LetterDelivery = "waiting" | "started" | "lost" | "ended" | null;

export interface InboxBook {
  delivery(id: string): LetterDelivery;
  redeliver(dog: string, letter: StoredLetter): Promise<void>;
}

export interface ObjectInboxOptions {
  calls: Pick<DogObjectCalls, "inbox">;
  owned: (dog: string) => boolean;
  dogs: () => string[];
  book: () => InboxBook | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface Tracked {
  dog: string;
  stored: boolean;
  settling?: boolean;
}

export class ObjectInbox {
  private readonly options: ObjectInboxOptions;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly tracked = new Map<string, Tracked>();
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  readonly state = { put: 0, acked: 0, redelivered: 0, failures: 0, lastError: null as string | null };

  constructor(options: ObjectInboxOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.log = options.log ?? ((line) => console.warn(line));
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pending(): number {
    return this.tracked.size;
  }

  async sent(dog: string, letter: Omit<InboxLetter, "at">): Promise<void> {
    if (!this.options.owned(dog)) return;
    this.tracked.set(letter.clientId, { dog, stored: false });
    const full: InboxLetter = { ...letter, at: this.now() };
    for (let attempt = 0; ; attempt++) {
      try {
        await this.options.calls.inbox(letter.from, letter.fromChat, { op: "put", dog, letter: full });
        this.state.put += 1;
        const held = this.tracked.get(letter.clientId);
        if (held) held.stored = true;
        this.changed();
        return;
      } catch (error) {
        this.fail(error);
        if (attempt >= RETRY_MS.length) return;
        await this.wait(RETRY_MS[attempt]!);
      }
    }
  }

  changed(): void {
    const book = this.options.book();
    if (!book) return;
    for (const [clientId, held] of this.tracked) {
      if (!held.stored || held.settling) continue;
      const delivery = book.delivery(clientId);
      if (delivery === "waiting") continue;
      held.settling = true;
      void this.settle(held.dog, clientId, delivery, book);
    }
  }

  private async settle(dog: string, clientId: string, delivery: LetterDelivery, book: InboxBook): Promise<void> {
    if (delivery === "lost") {
      const status = await this.options.calls.inbox(dog, DOG_CHAT, { op: "pull", limit: 200 }).catch(() => null);
      const letter = ((status?.letters ?? []) as StoredLetter[]).find((candidate) => candidate.clientId === clientId);
      if (letter) {
        await book.redeliver(dog, letter);
        this.state.redelivered += 1;
      }
    }
    await this.ack(dog, [clientId]);
    const held = this.tracked.get(clientId);
    if (held) held.settling = false;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const book = this.options.book();
      if (!book) return;
      for (const dog of this.options.dogs()) {
        if (!this.options.owned(dog)) continue;
        await this.reconcile(dog, book).catch((error) => this.fail(error));
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async reconcile(dog: string, book: InboxBook): Promise<void> {
    let after = 0;
    for (;;) {
      const answer = await this.options.calls.inbox(dog, DOG_CHAT, { op: "pull", after, limit: 50 });
      const letters = (answer.letters ?? []) as StoredLetter[];
      if (!letters.length) return;
      const done: string[] = [];
      for (const letter of letters) {
        after = letter.seq;
        if (this.tracked.has(letter.clientId) && !this.tracked.get(letter.clientId)!.stored) continue;
        const delivery = book.delivery(letter.clientId);
        if (delivery === "waiting") {
          this.tracked.set(letter.clientId, { dog, stored: true });
          continue;
        }
        const lost = delivery === "lost" || (delivery === null && letter.at < this.startedAt);
        if (lost && letter.at >= this.startedAt - REDELIVER_WITHIN_MS) {
          await book.redeliver(dog, letter);
          this.state.redelivered += 1;
        }
        done.push(letter.clientId);
      }
      if (done.length) await this.ack(dog, done);
      if (letters.length < 50) return;
    }
  }

  private async ack(dog: string, clientIds: string[]): Promise<void> {
    try {
      await this.options.calls.inbox(dog, DOG_CHAT, { op: "ack", clientIds });
      this.state.acked += clientIds.length;
      for (const clientId of clientIds) this.tracked.delete(clientId);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.state.failures += 1;
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.log(`object inbox: ${this.state.lastError}`);
  }
}
