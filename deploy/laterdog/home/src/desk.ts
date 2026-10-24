import { hex, sha256 } from "./encoding.ts";

export const DESK_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
export const DESK_READ_MAX_BYTES = 4 * 1024 * 1024;
export const DESK_SHELL_MAX_BYTES = 16 * 1024 * 1024;
export const DESK_SEND_MAX_BYTES = 256 * 1024;
export const DESK_OUTBOX_MAX = 50;
export const DESK_SAVE_EVERY_MS = 5_000;
export const SAVED_HEADER = "x-laterdog-saved-at";

const NEVER_SAVED = /^\/api\/(?:events|health|auth\/(?:pair|status|sessions|sign-out|code)|cloud\/|computer|bots\/[^/]+\/computer|files|attachments|assets|tts\/speak|live\/token)/;
const SEND_PATH = /^\/api\/(?:bots|groups)\/[^/]+\/messages$/;
const SHELL_TYPES = /^(?:text\/html|text\/css|(?:application|text)\/javascript|application\/(?:json|manifest\+json)|font\/|image\/)/;
const SEND_ID = /^[A-Za-z0-9_-]{16,80}$/;
const KEPT_HEADERS = ["content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options", "permissions-policy"];
const FORWARDED = ["authorization", "cookie", "content-type", "accept", "accept-language", "user-agent", "x-laterdog-client"];

export interface DeskObject {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface DeskBucket {
  get(key: string): Promise<DeskObject | null>;
  put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export interface QueuedSend {
  id: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

export type DeskKind = "read" | "shell" | null;

export function deskKind(request: Request): DeskKind {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/hooks/")) return null;
  if (url.pathname.startsWith("/api/")) return NEVER_SAVED.test(url.pathname) ? null : "read";
  return "shell";
}

export function deskSend(request: Request): boolean {
  return request.method === "POST" && SEND_PATH.test(new URL(request.url).pathname) && (request.headers.get("content-type") ?? "").includes("application/json");
}

export function savable(kind: Exclude<DeskKind, null>, response: Response): boolean {
  if (response.status !== 200) return false;
  const type = response.headers.get("content-type") ?? "";
  if (kind === "read") return type.startsWith("application/json");
  return SHELL_TYPES.test(type) && !/no-store/i.test(response.headers.get("cache-control") ?? "");
}

export async function deskKey(home: string, scope: string, url: string): Promise<string> {
  const { pathname, search } = new URL(url);
  return `homes/${home}/desk/${scope}/${hex(await sha256(`${pathname}${search}`))}`;
}

export function deskPrefix(home: string, scope: string): string {
  return `homes/${home}/desk/${scope}/`;
}

export async function saveAnswer(bucket: DeskBucket, key: string, response: Response, kind: Exclude<DeskKind, null>, now: number): Promise<string | null> {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > (kind === "read" ? DESK_READ_MAX_BYTES : DESK_SHELL_MAX_BYTES)) return null;
  const digest = hex(await sha256(new Uint8Array(bytes)));
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: response.headers.get("content-type") ?? "application/octet-stream" },
    customMetadata: { at: String(now), digest, headers: JSON.stringify(Object.fromEntries(KEPT_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [[name, value]] : [];
    }))) },
  });
  return digest;
}

export async function savedAnswer(bucket: DeskBucket, key: string, now: number): Promise<Response | null> {
  const saved = await bucket.get(key).catch(() => null);
  const at = Number(saved?.customMetadata?.at);
  if (!saved?.body || !Number.isFinite(at) || now - at > DESK_KEPT_MS) return null;
  let kept: Record<string, string> = {};
  try {
    kept = JSON.parse(saved.customMetadata?.headers ?? "{}") as Record<string, string>;
  } catch {}
  return new Response(saved.body, {
    status: 200,
    headers: {
      ...Object.fromEntries(Object.entries(kept).filter(([name, value]) => KEPT_HEADERS.includes(name) && typeof value === "string")),
      "content-type": saved.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "no-store",
      [SAVED_HEADER]: new Date(at).toISOString(),
    },
  });
}

export async function forgetScope(bucket: DeskBucket, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    removed += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export async function queuedSend(request: Request, now: number): Promise<QueuedSend | "refused" | null> {
  const body = await request.text();
  if (body.length > DESK_SEND_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const sendId = (parsed as { sendId?: unknown } | null)?.sendId;
  if (sendId !== undefined && (typeof sendId !== "string" || !SEND_ID.test(sendId))) return "refused";
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return { id: typeof sendId === "string" && sendId ? sendId : crypto.randomUUID(), path: new URL(request.url).pathname, headers, body, at: now };
}

export function withQueued(outbox: readonly QueuedSend[], next: QueuedSend): QueuedSend[] | null {
  if (outbox.some((queued) => queued.id === next.id)) return [...outbox];
  if (outbox.length >= DESK_OUTBOX_MAX) return null;
  return [...outbox, next];
}

export function refusedSend(): Response {
  return Response.json({ error: "sendId must be a client-generated id" }, { status: 400, headers: { "cache-control": "no-store" } });
}

export function queuedReceipt(queued: QueuedSend): Response {
  return Response.json({ ok: true, queued: true, queueId: queued.id }, { status: 202, headers: { "cache-control": "no-store" } });
}

export type Delivery = "delivered" | "refused" | "retry";

export function deliveryOutcome(status: number | null): Delivery {
  if (status === null || status >= 500 || status === 429 || status === 408) return "retry";
  return status >= 200 && status < 300 ? "delivered" : "refused";
}
