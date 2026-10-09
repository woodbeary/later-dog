export interface LimitHoldOptions {
  restsUntil: (instanceId: string) => string | undefined;
  wake: () => void;
  now?: () => number;
}

const LONGEST_TIMER_MS = 2_147_000_000;

export class LimitHold {
  private readonly held = new Map<string, { instanceId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly options: LimitHoldOptions;
  private readonly now: () => number;

  constructor(options: LimitHoldOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  hold(threadId: string, instanceId: string): void {
    this.release(threadId);
    const until = Date.parse(this.options.restsUntil(instanceId) ?? "");
    if (!(until > this.now())) return;
    const timer = setTimeout(() => {
      this.held.delete(threadId);
      this.hold(threadId, instanceId);
      if (!this.held.has(threadId)) this.options.wake();
    }, Math.min(until - this.now(), LONGEST_TIMER_MS));
    timer.unref?.();
    this.held.set(threadId, { instanceId, timer });
  }

  release(threadId: string): void {
    const entry = this.held.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.held.delete(threadId);
  }

  holds(threadId: string): boolean {
    const entry = this.held.get(threadId);
    if (!entry) return false;
    if (Date.parse(this.options.restsUntil(entry.instanceId) ?? "") > this.now()) return true;
    this.release(threadId);
    return false;
  }
}
