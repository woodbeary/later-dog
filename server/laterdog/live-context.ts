export const LIVE_CONTEXT_EVERY_MS = 10_000;
export const LIVE_CONTEXT_STEP = 0.02;

export class LiveContext {
  readonly #shown = new Map<string, { tokens: number; at: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  due(threadId: string, tokens: number | undefined): tokens is number {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return false;
    const at = this.#now();
    const last = this.#shown.get(threadId);
    if (last && (at - last.at < LIVE_CONTEXT_EVERY_MS || Math.abs(tokens - last.tokens) < last.tokens * LIVE_CONTEXT_STEP)) return false;
    this.#shown.set(threadId, { tokens, at });
    return true;
  }

  forget(threadId: string): void {
    this.#shown.delete(threadId);
  }
}
