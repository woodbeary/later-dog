export interface LimitHoldOptions {
  readyAt: (threadId: string) => string | undefined;
  wake: (threadId: string) => void;
  onChange?: () => void;
  now?: () => number;
}

export const RECHECK_MS = 60_000;

export class LimitHold {
  private readonly held = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: LimitHoldOptions;
  private readonly now: () => number;

  constructor(options: LimitHoldOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  hold(threadId: string): void {
    const before = this.held.get(threadId)?.until;
    this.clear(threadId);
    const until = this.until(threadId);
    if (until !== undefined) this.arm(threadId, until);
    if (until !== before) this.options.onChange?.();
  }

  retry(threadId: string): void {
    this.release(threadId);
    const timer = setTimeout(() => {
      this.retries.delete(threadId);
      this.options.wake(threadId);
    }, RECHECK_MS);
    timer.unref?.();
    this.retries.set(threadId, timer);
  }

  release(threadId: string): void {
    const held = this.held.has(threadId);
    this.clear(threadId);
    if (held) this.options.onChange?.();
  }

  recheck(): void {
    const held = [...this.held];
    for (const [threadId, { timer }] of held) {
      clearTimeout(timer);
      this.check(threadId);
    }
  }

  holds(threadId: string): boolean {
    return this.held.has(threadId) && this.until(threadId) !== undefined;
  }

  waiting(): Record<string, string> {
    return Object.fromEntries([...this.held].map(([threadId, { until }]) => [threadId, new Date(until).toISOString()]));
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
    this.options.wake(threadId);
  }

  private clear(threadId: string): void {
    clearTimeout(this.held.get(threadId)?.timer);
    this.held.delete(threadId);
    clearTimeout(this.retries.get(threadId));
    this.retries.delete(threadId);
  }
}
