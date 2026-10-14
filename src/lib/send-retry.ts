export const SEND_RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 4_000, 8_000, 16_000];
export const SEND_ATTEMPT_TIMEOUT_MS = 90_000;
export const UNCERTAIN_SEND_MEMORY_MS = 10 * 60_000;

export const SEND_UNCERTAIN_MESSAGE =
  "Couldn't reach later.dog, so this message may not have been sent. It is back in the box, and sending it again won't make a copy.";

const GATEWAY_STATUSES = new Set([502, 503, 504]);

export function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && GATEWAY_STATUSES.has(status);
}

export function isUncertainSendFailure(error: unknown): boolean {
  if (isTransportFailure(error)) return true;
  if ((error as { name?: unknown } | null)?.name === "SendUncertainError") return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 500;
}

export interface SendRetryOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function sendWithRetry<T>(attempt: () => Promise<T>, options: SendRetryOptions = {}): Promise<T> {
  const delays = options.delays ?? SEND_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      if (tried >= delays.length) throw Object.assign(new Error(SEND_UNCERTAIN_MESSAGE), { name: "SendUncertainError" });
      options.onRetry?.(tried + 1, error);
      await sleep(delays[tried]!);
    }
  }
}

export class UncertainSends {
  private readonly held = new Map<string, { sendId: string; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(host: string, threadId: string | undefined, text: string, shape: string): string {
    return JSON.stringify([host, threadId ?? null, text, shape]);
  }

  remember(host: string, threadId: string | undefined, text: string, sendId: string, shape = ""): void {
    this.prune();
    this.held.set(this.key(host, threadId, text, shape), { sendId, at: this.now() });
  }

  recall(host: string, threadId: string | undefined, text: string, shape = ""): string | undefined {
    this.prune();
    return this.held.get(this.key(host, threadId, text, shape))?.sendId;
  }

  forget(host: string, threadId: string | undefined, text: string, shape = ""): void {
    this.held.delete(this.key(host, threadId, text, shape));
  }

  private prune(): void {
    const cutoff = this.now() - UNCERTAIN_SEND_MEMORY_MS;
    for (const [key, entry] of this.held) if (entry.at < cutoff) this.held.delete(key);
  }
}
