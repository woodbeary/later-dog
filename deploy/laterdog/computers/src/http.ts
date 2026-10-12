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
  total: number;
  ended: boolean;
}

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
      ended = !cancelled;
    } catch {}
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

export function outputText(collected: Collected): string {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(collected.bytes);
  if (collected.total <= collected.bytes.byteLength) return text;
  return `${text}\n[later.dog: output truncated; kept the first ${collected.bytes.byteLength} of ${collected.total} bytes]`;
}
