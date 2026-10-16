import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { HomeActivity } from "./home-activity.ts";

export interface LimitHoldOptions {
  readyAt: (threadId: string) => string | undefined;
  wake: (threadId: string) => void;
  onChange?: () => void;
  now?: () => number;
  file?: string;
}

export const RECHECK_MS = 60_000;
const MAX_SAVED = 1_000;

const savedSchema = z.object({
  version: z.literal(1),
  waiting: z.record(z.string().min(1).max(200), z.object({ since: z.string().max(64) })).default({}),
});

function readSaved(file: string | undefined): Map<string, string> {
  if (!file || !existsSync(file)) return new Map();
  try {
    const parsed = savedSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? new Map(Object.entries(parsed.data.waiting).map(([threadId, { since }]) => [threadId, since])) : new Map();
  } catch {
    return new Map();
  }
}

export function withWaitingRuns(activity: HomeActivity, wakeAt: number | undefined): HomeActivity {
  if (wakeAt === undefined || activity.busy) return activity;
  return { ...activity, nextAt: activity.nextAt === null ? wakeAt : Math.min(activity.nextAt, wakeAt) };
}

export class LimitHold {
  private readonly held = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly retries = new Map<string, { due: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly options: LimitHoldOptions;
  private readonly now: () => number;
  private readonly saved: Map<string, string>;
  private readonly fromBefore = new Set<string>();

  constructor(options: LimitHoldOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.saved = readSaved(options.file);
  }

  hold(threadId: string): void {
    const before = this.held.get(threadId)?.until;
    this.clear(threadId);
    const until = this.until(threadId);
    if (until !== undefined) this.arm(threadId, until);
    this.keep(threadId, until !== undefined);
    if (until !== before) this.options.onChange?.();
  }

  retry(threadId: string): void {
    const held = this.held.has(threadId);
    this.clear(threadId);
    const timer = setTimeout(() => {
      this.retries.delete(threadId);
      this.wakeUp(threadId);
    }, RECHECK_MS);
    timer.unref?.();
    this.retries.set(threadId, { due: this.now() + RECHECK_MS, timer });
    this.keep(threadId, true);
    if (held) this.options.onChange?.();
  }

  release(threadId: string): void {
    const held = this.held.has(threadId);
    this.clear(threadId);
    this.fromBefore.delete(threadId);
    this.keep(threadId, false);
    if (held) this.options.onChange?.();
  }

  recheck(): void {
    const held = [...this.held];
    for (const [threadId, { timer }] of held) {
      clearTimeout(timer);
      this.check(threadId);
    }
  }

  resume(): string[] {
    const waiting = [...this.saved.keys()].filter((threadId) => !this.held.has(threadId) && !this.retries.has(threadId));
    const due: string[] = [];
    for (const threadId of waiting) {
      this.fromBefore.add(threadId);
      const until = this.until(threadId);
      if (until === undefined) due.push(threadId);
      else this.arm(threadId, until);
    }
    if (waiting.length > due.length) this.options.onChange?.();
    for (const threadId of due) this.wakeUp(threadId);
    return waiting;
  }

  restored(threadId: string): boolean {
    return this.fromBefore.has(threadId);
  }

  holds(threadId: string): boolean {
    return this.held.has(threadId) && this.until(threadId) !== undefined;
  }

  waiting(): Record<string, string> {
    return Object.fromEntries([
      ...[...this.held].map(([threadId, { until }]) => [threadId, new Date(until).toISOString()]),
      ...[...this.retries.keys()].map((threadId) => [threadId, new Date(this.now() + RECHECK_MS).toISOString()]),
    ]);
  }

  nextAt(): number | undefined {
    const times = [...[...this.held.values()].map(({ until }) => until), ...[...this.retries.values()].map(({ due }) => due)];
    return times.length ? Math.min(...times) : undefined;
  }

  private until(threadId: string): number | undefined {
    const until = Date.parse(this.options.readyAt(threadId) ?? "");
    return until > this.now() ? until : undefined;
  }

  private arm(threadId: string, until: number): void {
    const timer = setTimeout(() => this.check(threadId), Math.min(until - this.now(), RECHECK_MS));
    timer.unref?.();
    this.held.set(threadId, { until, timer });
  }

  private check(threadId: string): void {
    const before = this.held.get(threadId)?.until;
    this.held.delete(threadId);
    const until = this.until(threadId);
    if (until !== undefined) {
      this.arm(threadId, until);
      if (until !== before) this.options.onChange?.();
      return;
    }
    this.options.onChange?.();
    this.wakeUp(threadId);
  }

  private wakeUp(threadId: string): void {
    this.options.wake(threadId);
    if (!this.held.has(threadId) && !this.retries.has(threadId)) {
      this.fromBefore.delete(threadId);
      this.keep(threadId, false);
    }
  }

  private clear(threadId: string): void {
    clearTimeout(this.held.get(threadId)?.timer);
    this.held.delete(threadId);
    clearTimeout(this.retries.get(threadId)?.timer);
    this.retries.delete(threadId);
  }

  private keep(threadId: string, waiting: boolean): void {
    if (!this.options.file || waiting === this.saved.has(threadId)) return;
    if (waiting) this.saved.set(threadId, new Date(this.now()).toISOString());
    else this.saved.delete(threadId);
    while (this.saved.size > MAX_SAVED) this.saved.delete(this.saved.keys().next().value!);
    try {
      writeFileAtomic(this.options.file, JSON.stringify({ version: 1, waiting: Object.fromEntries([...this.saved].map(([id, since]) => [id, { since }])) }),
        { mode: 0o600, durable: false });
    } catch (error) {
      console.warn(`limit hold: could not save ${this.options.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
