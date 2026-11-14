import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

export type EngineContextReply =
  | { kind: "answer"; answer: unknown }
  | { kind: "refused" }
  | { kind: "not-yet" }
  | { kind: "none" };

export const ENGINE_CONTEXT_REQUEST_PREFIX = "laterdog-context-";
export const ENGINE_CONTEXT_TIMEOUT_MS = 5_000;
export const ENGINE_CONTEXT_SILENCES_KEPT = 2;

const REFUSAL = /^Unsupported control request subtype/i;
const NOT_YET = /no turn received yet/i;

export function engineContextRequest(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_context_usage", detail: "summary" } })}\n`;
}

type Waiting = { settle: (reply: EngineContextReply) => void; timer: ReturnType<typeof setTimeout> };

export class EngineContextAsk {
  private refused = false;
  private silences = 0;
  private readonly waiting = new Map<string, Waiting>();
  private inFlight: Promise<EngineContextReply> | null = null;
  private readonly write: (line: string) => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(write: (line: string) => Promise<boolean>, timeoutMs = ENGINE_CONTEXT_TIMEOUT_MS) {
    this.write = write;
    this.timeoutMs = timeoutMs;
  }

  get knowsRefusal(): boolean {
    return this.refused;
  }

  ask(): Promise<EngineContextReply> {
    if (this.refused) return Promise.resolve({ kind: "refused" });
    if (this.inFlight) return this.inFlight;
    const requestId = `${ENGINE_CONTEXT_REQUEST_PREFIX}${randomUUID()}`;
    const asked = new Promise<EngineContextReply>((resolve) => {
      const settle = (reply: EngineContextReply) => {
        const entry = this.waiting.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete(requestId);
        resolve(reply);
      };
      const timer = setTimeout(() => {
        this.silences += 1;
        if (this.silences >= ENGINE_CONTEXT_SILENCES_KEPT) this.refused = true;
        settle({ kind: "none" });
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(requestId, { settle, timer });
      void this.write(engineContextRequest(requestId)).then((written) => { if (!written) settle({ kind: "none" }); }, () => settle({ kind: "none" }));
    });
    this.inFlight = asked.finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  receive(line: unknown): boolean {
    if (!line || typeof line !== "object" || (line as { type?: unknown }).type !== "control_response") return false;
    const response = (line as { response?: unknown }).response;
    if (!response || typeof response !== "object") return false;
    const { request_id: requestId, subtype, error } = response as { request_id?: unknown; subtype?: unknown; error?: unknown; response?: unknown };
    if (typeof requestId !== "string" || !requestId.startsWith(ENGINE_CONTEXT_REQUEST_PREFIX)) return false;
    const entry = this.waiting.get(requestId);
    if (!entry) return true;
    this.silences = 0;
    if (subtype === "success") {
      entry.settle({ kind: "answer", answer: (response as { response?: unknown }).response });
      return true;
    }
    const message = typeof error === "string" ? error : "";
    if (REFUSAL.test(message)) {
      this.refused = true;
      entry.settle({ kind: "refused" });
    } else {
      entry.settle(NOT_YET.test(message) ? { kind: "not-yet" } : { kind: "none" });
    }
    return true;
  }

  close(): void {
    for (const entry of this.waiting.values()) entry.settle({ kind: "none" });
  }
}

export function writeEngineLine(stdin: Writable, line: string): Promise<boolean> {
  if (!stdin.writable || stdin.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const quiet = () => {};
    stdin.on("error", quiet);
    const done = (written: boolean) => {
      setImmediate(() => stdin.off("error", quiet));
      resolve(written);
    };
    try {
      stdin.write(line, (error) => done(!error));
    } catch {
      done(false);
    }
  });
}
