import { sha256 } from "./encoding.ts";

export const STATE_HOST = "state.r2";
export const EMAIL_HOST = "email.internal";
const STATE_KEY = /^(?:manifest\.json|blobs\/[a-f0-9]{64}|restore-points\/\d{1,16}\.json)$/;
const BLOB_KEY = /\/blobs\/[a-f0-9]{64}$/;
const RESTORE_POINT_KEY = /\/restore-points\/\d{1,16}\.json$/;
const BLOB_HASH = /^[a-f0-9]{64}$/;
const RESTORE_POINT_NAME = /^\d{1,16}\.json$/;
const BLOB_LIST_PATH = "/blobs/";
const RESTORE_POINT_LIST_PATH = "/restore-points/";
const CONTAINER_ID = /^[a-f0-9]{16,128}$/;

export interface StateBucket {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<{ body: ReadableStream; httpEtag: string } | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export function homePrefix(containerId: string): string {
  if (!CONTAINER_ID.test(containerId)) throw new Error("invalid container id");
  return `homes/${containerId}/`;
}

export function stateOwner(context: { containerId: string; params?: { home?: string } }): string {
  return context.params?.home ?? context.containerId;
}

export function stateKey(containerId: string, url: string): string | null {
  const name = new URL(url).pathname.replace(/^\/+/, "");
  if (!STATE_KEY.test(name)) return null;
  return `${homePrefix(containerId)}${name}`;
}

export async function handleState(request: Request, bucket: StateBucket, containerId: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === BLOB_LIST_PATH && request.method === "GET") {
    const prefix = `${homePrefix(containerId)}blobs/`;
    const page = await bucket.list({ prefix, cursor: url.searchParams.get("cursor") || undefined, limit: 1000 });
    const hashes = page.objects.map((object) => object.key.slice(prefix.length)).filter((hash) => BLOB_HASH.test(hash));
    return Response.json({ hashes, ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) });
  }
  if (url.pathname === RESTORE_POINT_LIST_PATH && request.method === "GET") {
    return Response.json({ names: await restorePointNames(bucket, containerId) });
  }
  const key = stateKey(containerId, request.url);
  if (!key) return new Response("Invalid state key", { status: 400 });
  if (request.method === "HEAD") return new Response(null, { status: (await bucket.head(key)) ? 200 : 404 });
  if (request.method === "GET") {
    const object = await bucket.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": "application/octet-stream", etag: object.httpEtag } });
  }
  if (request.method === "PUT") {
    await bucket.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: "application/octet-stream" } });
    return new Response("Stored", { status: 201 });
  }
  if (request.method === "DELETE" && (BLOB_KEY.test(key) || RESTORE_POINT_KEY.test(key))) {
    await bucket.delete(key);
    return new Response(null, { status: 204 });
  }
  return new Response("Method not allowed", { status: 405 });
}

async function restorePointNames(bucket: StateBucket, containerId: string): Promise<string[]> {
  const prefix = `${homePrefix(containerId)}restore-points/`;
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    names.push(...page.objects.map((object) => object.key.slice(prefix.length)).filter((name) => RESTORE_POINT_NAME.test(name)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return names;
}

export async function forgetHomeState(bucket: StateBucket, containerId: string): Promise<number> {
  const prefix = homePrefix(containerId);
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

export async function authorizedState(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const presented = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const [given, expected] = await Promise.all([sha256(presented), sha256(token)]);
  let difference = given.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) difference |= (given[index] ?? 0) ^ expected[index];
  return difference === 0 && presented.length > 0;
}
