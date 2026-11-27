import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";

export const HISTORY_ROUTE = "/api/internal/coordinator/history";
export const MAX_MESSAGE_BYTES = 256 * 1024;
const BATCH = 50;
const DELAY_MS = 500;
const CALL_MS = 10_000;
const TOKEN_MS = 10 * 60_000;
const MAX_PENDING_CHATS = 2_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface MirroredMessage {
  id: string;
  at: number;
  json: string;
}

export interface HistoryMirrorOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  read(threadId: string, ids: readonly string[]): MirroredMessage[];
  ownerOf(threadId: string): string | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class HistoryMirror {
  private readonly options: HistoryMirrorOptions;
  private readonly secret: Buffer;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  private readonly dirty = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private attempt = 0;
  enabled = false;
  readonly state = { sent: 0, skipped: 0, failures: 0, dropped: 0, lastError: null as string | null };

  constructor(options: HistoryMirrorOptions) {
    this.options = options;
    this.secret = capabilitySecret(options.bootstrapSecret);
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  wrote(threadId: string, id: string): void {
    if (!this.enabled) return;
    const ids = this.dirty.get(threadId);
    if (ids) ids.add(id);
    else {
      if (this.dirty.size >= MAX_PENDING_CHATS) {
        this.state.dropped += 1;
        return;
      }
      this.dirty.set(threadId, new Set([id]));
    }
    this.schedule();
  }

  pending(): number {
    let count = 0;
    for (const ids of this.dirty.values()) count += ids.size;
    return count;
  }

  async idle(): Promise<void> {
    for (let rounds = 0; rounds < 20 && this.enabled && (this.flushing || this.timer || this.dirty.size); rounds += 1) {
      if (this.flushing) {
        await this.flushing;
        continue;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.flush();
    }
  }

  private schedule(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushing = this.flush().finally(() => {
        this.flushing = null;
        if (this.dirty.size && this.enabled) this.schedule();
      });
    }, this.attempt ? RETRY_MS[Math.min(this.attempt - 1, RETRY_MS.length - 1)] : DELAY_MS);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    for (const [threadId, ids] of this.dirty) {
      const dog = this.options.ownerOf(threadId);
      const picked = [...ids].slice(0, BATCH);
      if (!dog) {
        this.dirty.delete(threadId);
        continue;
      }
      const rows = this.options.read(threadId, picked).filter((row) => {
        if (row.json.length <= MAX_MESSAGE_BYTES) return true;
        this.state.skipped += 1;
        return false;
      });
      try {
        if (rows.length) await this.call(dog, threadId, rows);
        for (const id of picked) ids.delete(id);
        if (!ids.size) this.dirty.delete(threadId);
        this.state.sent += rows.length;
        this.attempt = 0;
      } catch (error) {
        this.state.failures += 1;
        this.state.lastError = (error as Error).message;
        this.attempt += 1;
        return;
      }
    }
  }

  private async call(dog: string, chat: string, messages: MirroredMessage[]): Promise<void> {
    const at = this.now();
    const token = signCapabilitySync(this.secret, { home: this.options.home, dog, chat, generation: "history", kind: "turns", issuedAt: at, expiresAt: at + TOKEN_MS });
    const response = await this.send(`${this.options.origin}${HISTORY_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "append", messages }),
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!response.ok) throw new Error(`history append answered ${response.status}`);
  }
}
