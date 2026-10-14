export const TRACE_PREFIX = "traces/";
export const TRACE_KEY = /^traces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl\.gz$/;
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365;
export const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_PAGE = 1000;

export interface TraceObjectBody { body: ReadableStream; httpEtag: string; customMetadata?: Record<string, string> }

export interface TraceBucket {
  get(key: string): Promise<TraceObjectBody | null>;
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number; include?: ("customMetadata")[] }): Promise<{ objects: Array<{ key: string; customMetadata?: Record<string, string> }>; truncated: boolean; cursor?: string }>;
}

export function retentionDays(requested: string | null | undefined, configured: string | undefined): number {
  for (const raw of [requested, configured]) {
    const days = Number(raw?.trim());
    if (raw !== undefined && raw !== null && raw.trim() !== "" && Number.isInteger(days) && days >= 1) return Math.min(days, MAX_RETENTION_DAYS);
  }
  return DEFAULT_RETENTION_DAYS;
}

function expired(metadata: Record<string, string> | undefined, now: number): boolean {
  const expiresAt = Date.parse(metadata?.expiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export async function handleTrace(request: Request, bucket: TraceBucket, key: string, options: { configuredDays?: string; now?: number } = {}): Promise<Response> {
  if (!TRACE_KEY.test(key)) return new Response("Invalid trace key", { status: 400 });
  const now = options.now ?? Date.now();
  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_TRACE_BYTES) return new Response("A trace is 1 byte to 16 MB", { status: 413 });
    const magic = new Uint8Array(body, 0, Math.min(2, body.byteLength));
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) return new Response("A trace is gzip", { status: 415 });
    const days = retentionDays(request.headers.get("x-laterdog-retain-days"), options.configuredDays);
    const expiresAt = new Date(now + days * DAY_MS).toISOString();
    await bucket.put(key, body, { httpMetadata: { contentType: "application/gzip" },
      customMetadata: { expiresAt, retainDays: String(days), truncated: request.headers.get("x-laterdog-truncated") === "1" ? "1" : "0" } });
    return Response.json({ key, bytes: body.byteLength, expiresAt }, { status: 201 });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const found = await bucket.get(key);
    if (!found) return new Response("Not found", { status: 404 });
    if (expired(found.customMetadata, now)) {
      await bucket.delete(key);
      await found.body.cancel().catch(() => undefined);
      return new Response("Expired", { status: 410 });
    }
    if (request.method === "HEAD") { await found.body.cancel().catch(() => undefined); return new Response(null, { status: 200, headers: { "x-laterdog-trace-expires": found.customMetadata?.expiresAt ?? "" } }); }
    return new Response(found.body, { headers: { "content-type": "application/gzip", etag: found.httpEtag, "x-laterdog-trace-expires": found.customMetadata?.expiresAt ?? "" } });
  }
  return new Response("Method not allowed", { status: 405 });
}

export async function sweepTraces(bucket: TraceBucket, now: number): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: TRACE_PREFIX, cursor, limit: SWEEP_PAGE, include: ["customMetadata"] });
    const stale = page.objects.filter((object) => expired(object.customMetadata, now)).map((object) => object.key);
    if (stale.length) await bucket.delete(stale);
    removed += stale.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export function sweepDue(now: number): boolean {
  return new Date(now).getUTCMinutes() < 5;
}
