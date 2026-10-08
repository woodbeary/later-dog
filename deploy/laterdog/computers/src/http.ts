// Small HTTP and stream helpers shared by the Worker and the Durable Objects. No runtime imports, so they are unit tested.

import type { Refusal } from "./auth";

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function apiError(refusal: Refusal, headers: Record<string, string> = {}): Response {
  return json({ error: { code: refusal.code, message: refusal.message } }, refusal.status, headers);
}

export class TooLarge extends Error {
  constructor(readonly limit: number) {
    super(`The body is larger than ${limit} bytes.`);
  }
}

/** Reads a whole body, refusing it as soon as it grows past `limit` bytes (so a huge upload is never buffered). */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(limit);
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

export function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Resolves with the promise's value, or with undefined once `ms` have passed. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface Collected {
  bytes: Uint8Array;
  /** Every byte the stream produced, including those past the cap. */
  total: number;
  /** False when the stream was still open and had to be cancelled. */
  ended: boolean;
}

/**
 * Drains a process's output stream from the start, keeping at most `cap` bytes and discarding the rest, so a chatty
 * process never blocks on a full pipe. `settle(graceMs)` waits up to `graceMs` for the stream to end and then cancels it:
 * a background child that inherited the pipe must not hold the answer hostage after the command itself exited.
 */
export function collect(stream: ReadableStream<Uint8Array> | null | undefined, cap: number): { settle(graceMs: number): Promise<Collected> } {
  if (!stream) return { settle: async () => ({ bytes: new Uint8Array(0), total: 0, ended: true }) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let ended = false;
  let cancelled = false;
  const drained = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (kept < cap) {
          const slice = value.subarray(0, cap - kept);
          chunks.push(slice);
          kept += slice.byteLength;
        }
      }
      // A cancel resolves the pending read as done, which is not the stream ending.
      ended = !cancelled;
    } catch {
      // Cancelled by settle(), or the process went away; keep what arrived.
    }
  })();
  return {
    async settle(graceMs: number) {
      const finished = await within(drained.then(() => true), graceMs);
      if (!finished) {
        cancelled = true;
        await reader.cancel().catch(() => {});
      }
      return { bytes: concat(chunks, kept), total, ended };
    },
  };
}

/** Decodes captured output as UTF-8 and says so when bytes were dropped past the cap. */
export function outputText(collected: Collected): string {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(collected.bytes);
  if (collected.total <= collected.bytes.byteLength) return text;
  return `${text}\n[later.dog: output truncated; kept the first ${collected.bytes.byteLength} of ${collected.total} bytes]`;
}
