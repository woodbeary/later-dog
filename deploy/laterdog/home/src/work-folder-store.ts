import { registerFolder } from "./work-folder-registry.ts";
import { eligibleSharedFolder, readWorkFolderPlacement } from "./work-folder-placement.ts";
import { compareWorkFolderPaths, safeWorkFolderLink, safeWorkFolderPath, validWorkFolderScope, workFolderAuthority, workFolderBaseUrl, WORK_FOLDER_ACCESS_MS, WORK_FOLDER_BLOB_BYTES, WORK_FOLDER_PAGE_SIZE, WORK_FOLDER_ROUTE, type WorkFolderHead, type WorkFolderPageInfo } from "../../../../shared/work-folder-store.ts";
import { hex, hmacSha256, randomToken, sha256, sha256Stream } from "./encoding.ts";
import { homePrefix } from "./state.ts";

type WriteOptions = { onlyIf: { etagMatches: string } | { etagDoesNotMatch: string }; sha256?: string; httpMetadata?: { contentType: string } };
type ObjectData = { etag: string; size: number; body: ReadableStream<Uint8Array> };
export interface WorkFolderBucket {
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<ObjectData | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, options: WriteOptions): Promise<unknown | null>;
}

interface Scope {
  prefix: string;
  stable: string;
  owner: string;
  folderId: string;
  baseUrl: string;
  authority: string;
  bucket: WorkFolderBucket;
  now: number;
}

interface Summary {
  self: WorkFolderPageInfo;
  children: ({ hash: string } & WorkFolderPageInfo)[];
}

class FolderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new FolderError(400, message); };
const digest = (bytes: string | Uint8Array) => sha256(bytes).then(hex);
const hashPattern = /^[0-9a-f]{64}$/;
const validHash = (value: unknown): value is string => typeof value === "string" && hashPattern.test(value);
const validSize = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validMode = (value: unknown): value is number => validSize(value) && value <= 0o7777;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const withTime = (v: Record<string, unknown>, keys: string[]) => v.mtimeMs === undefined ? exact(v, keys) : typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs) && Math.abs(v.mtimeMs) <= 8.64e15 && exact(v, [...keys, "mtimeMs"]);
const guestPattern = /^cmp_[a-z0-9]{1,64}$/;
const generationPattern = /^[A-Za-z0-9_-]{22}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const absent = () => json({ error: "not_found" }, 404);

function boundedSum(a: number, b: number): number {
  return validSize(a + b) ? a + b : invalid("Manifest size is not representable");
}

async function payload(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > max) { await reader.cancel(); throw new FolderError(413, "Object exceeds the transfer page size"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length);
  let at = 0;
  for (const data of chunks) { out.set(data, at); at += data.length; }
  return out;
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (record(value)) return value;
  } catch {}
  return invalid("Invalid JSON object");
}

async function jsonRecord<T>(bucket: WorkFolderBucket, key: string): Promise<{ value: T; etag: string } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return { value: await new Response(obj.body).json() as T, etag: obj.etag };
}

async function immutable(bucket: WorkFolderBucket, key: string, data: string | Uint8Array, contentType: string): Promise<void> {
  await bucket.put(key, data, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType } });
}

function collection(value: unknown, check: (v: unknown) => boolean): unknown[] {
  if (!Array.isArray(value) || value.length > WORK_FOLDER_PAGE_SIZE || !value.every(check)) return invalid("Invalid manifest page");
  return value;
}

async function summary(scope: Scope, hash: string): Promise<Summary> {
  const row = await jsonRecord<Summary>(scope.bucket, scope.prefix + "summaries/" + hash);
  if (!row) throw new FolderError(422, "Missing manifest dependency");
  return row.value;
}

async function validateNode(scope: Scope, node: Record<string, unknown>): Promise<Summary> {
  if (node.v !== 1) return invalid("Unknown manifest version");
  if (node.kind === "chunks" && exact(node, ["v", "kind", "hashes"])) {
    const hashes = collection(node.hashes, validHash) as string[];
    const unique = [...new Set(hashes)];
    const objects = new Map(await Promise.all(unique.map(async h => [h, await scope.bucket.head(scope.prefix + "blobs/" + h)] as const)));
    let bytes = 0;
    for (const h of hashes) {
      const blob = objects.get(h);
      if (!blob) throw new FolderError(422, "Missing file chunk");
      bytes = boundedSum(bytes, blob.size);
    }
    return { self: { of: "chunks", bytes, count: hashes.length }, children: [] };
  }
  if (node.kind === "entries" && exact(node, ["v", "kind", "entries"])) {
    const entries = collection(node.entries, record) as Record<string, unknown>[];
    let previous: string | undefined;
    for (const e of entries) {
      if (!safeWorkFolderPath(e.path) || (previous !== undefined && compareWorkFolderPaths(previous, e.path) >= 0)) return invalid("Invalid or unsorted work folder path");
      previous = e.path;
      if (scope.folderId === "loose" && (e.path.includes("/") || e.path.startsWith(".") || e.kind === "dir")) return invalid("Invalid loose working file");
      if (e.kind === "dir" && withTime(e, ["kind", "path", "mode"]) && validMode(e.mode)) continue;
      if (e.kind === "link" && typeof e.target === "string" && e.target.length > 0 && !e.target.includes("\0")) {
        const fields = ["kind", "path", "target"];
        if (e.mode !== undefined) {
          if (!validMode(e.mode)) return invalid("Invalid link mode");
          fields.push("mode");
        }
        if (withTime(e, fields) && safeWorkFolderLink(e.path, e.target)) continue;
        if (withTime(e, [...fields, "scopedTarget"]) && (e.scopedTarget === null || safeWorkFolderLink(e.path, e.scopedTarget))) continue;
      }
      if (e.kind === "file" && validMode(e.mode) && validSize(e.size) && validHash(e.sha256) && validHash(e.contents)) {
        const fields = ["kind", "path", "mode", "size", "sha256", "contents"];
        if (e.hardlink !== undefined) {
          if (!safeWorkFolderPath(e.hardlink) || compareWorkFolderPaths(e.hardlink, e.path) >= 0) return invalid("Invalid working folder hard link");
          fields.push("hardlink");
        }
        if (withTime(e, fields)) continue;
      }
      return invalid("Invalid work folder entry");
    }
    const files = entries.filter(e => e.kind === "file");
    const contents = await Promise.all(files.map(e => summary(scope, e.contents as string)));
    let bytes = 0;
    for (const [i, e] of files.entries()) {
      const content = contents[i]!.self;
      if (content.of !== "chunks" || content.bytes !== e.size) return invalid("File chunk length differs");
      bytes = boundedSum(bytes, content.bytes);
    }
    return { self: { of: "entries", count: entries.length, bytes, ...(entries.length ? { first: entries[0]!.path as string, last: previous } : {}) }, children: [] };
  }
  if (node.kind === "pages" && exact(node, ["v", "kind", "of", "children"]) && (node.of === "chunks" || node.of === "entries")) {
    const hashes = collection(node.children, validHash) as string[];
    if (!hashes.length) return invalid("Empty branch");
    const children = await Promise.all(hashes.map(async hash => ({ hash, ...(await summary(scope, hash)).self })));
    let count = 0, bytes = 0, last: string | undefined;
    for (const child of children) {
      if (child.of !== node.of || !child.count) return invalid("Wrong or empty child page");
      if (node.of === "entries" && (!child.first || !child.last || (last !== undefined && compareWorkFolderPaths(last, child.first) >= 0))) return invalid("Overlapping directory pages");
      last = child.last;
      count = boundedSum(count, child.count); bytes = boundedSum(bytes, child.bytes);
    }
    return { self: { of: node.of, bytes, count, ...(last ? { first: children[0]!.first, last } : {}) }, children };
  }
  if (node.kind === "root" && withTime(node, ["v", "kind", "mode", "entries"]) && validMode(node.mode) && validHash(node.entries)) {
    const info = (await summary(scope, node.entries)).self;
    if (info.of !== "entries") return invalid("Root has no entry page");
    return { self: { ...info, of: "root" }, children: [{ hash: node.entries, ...info }] };
  }
  return invalid("Invalid manifest node");
}

async function sameToken(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

interface GuestAccess { generation: string; active: boolean; grantee: string }

async function allowedGrantee(scope: Scope, grantee: string): Promise<boolean> {
  if (grantee === scope.owner) return true;
  const layout = await readWorkFolderPlacement(scope.bucket, scope.stable);
  return layout?.mode === "folders" && await eligibleSharedFolder(layout.layout, scope.owner, scope.folderId, grantee);
}
async function issued(scope: Scope, guest: string, generation: string) {
  const expiresAt = scope.now + WORK_FOLDER_ACCESS_MS;
  const sign = async (stem: string) => stem + "." + hex(await hmacSha256(scope.authority, stem));
  const [accessToken, refreshToken] = await Promise.all([sign(["wfx",guest,generation,expiresAt].join(".")), sign(["wfr",guest,generation].join("."))]);
  return { baseUrl: scope.baseUrl, guestId: guest, accessToken, expiresAt, refreshToken };
}

async function guest(scope: Scope, token: string, refresh: boolean): Promise<{ guestId: string; generation: string } | null> {
  const fields = token.split(".");
  if (fields.length !== (refresh ? 4 : 5) || fields[0] !== (refresh ? "wfr" : "wfx") || !guestPattern.test(fields[1]!) || !generationPattern.test(fields[2]!)) return null;
  if (!refresh && (!/^\d{1,16}$/.test(fields[3]!) || Number(fields[3]) <= scope.now || Number(fields[3]) > scope.now + WORK_FOLDER_ACCESS_MS)) return null;
  const signature = fields.pop()!, expected = hex(await hmacSha256(scope.authority, fields.join(".")));
  if (!validHash(signature) || !(await sameToken(signature, expected))) return null;
  const grant = await jsonRecord<GuestAccess>(scope.bucket, scope.prefix + "grants/" + fields[1]);
  return grant?.value.active && grant.value.generation === fields[2] && await allowedGrantee(scope, grant.value.grantee) ? { guestId: fields[1]!, generation: fields[2]! } : null;
}

async function grant(scope: Scope, request: Request, revoke: boolean): Promise<Response> {
  const value = parse(await payload(request, 2048));
  if (!(exact(value, ["guestId"]) || exact(value, ["guestId", "granteeBotId"])) || typeof value.guestId !== "string" || !guestPattern.test(value.guestId)) return invalid("Invalid assigned guest");
  const grantee = value.granteeBotId ?? scope.owner;
  if (typeof grantee !== "string" || !validWorkFolderScope(grantee, scope.folderId)) return invalid("Invalid guest owner");
  if (!revoke && !await allowedGrantee(scope, grantee)) return json({ error: "forbidden" }, 403);
  const key = scope.prefix + "grants/" + value.guestId;
  for (let n = 0; n < 4; n++) {
    const old = await jsonRecord<GuestAccess>(scope.bucket, key);
    if (revoke && !old?.value.active) return new Response(null, { status: 204 });
    if (!revoke && old?.value.active) return old.value.grantee === grantee ? json(await issued(scope, value.guestId, old.value.generation)) : json({ error: "guest_already_assigned" }, 409);
    const next = { generation: randomToken(16), active: !revoke, grantee };
    const wrote = await scope.bucket.put(key, JSON.stringify(next), { onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: "*" } });
    if (wrote) return revoke ? new Response(null, { status: 204 }) : json(await issued(scope, value.guestId, next.generation));
  }
  return json({ error: "grant_changed" }, 409);
}

type SavedHead = WorkFolderHead & { fence?: string };

function versionOf(head: SavedHead): WorkFolderHead {
  return { revision: head.revision, parent: head.parent, manifest: head.manifest, state: head.state };
}

async function folderFence(scope: Scope, request: Request, release: boolean): Promise<Response> {
  const body = parse(await payload(request, 2048));
  if (!exact(body, ["fence", "revision"]) || !validHash(body.fence) || !validHash(body.revision)) return invalid("Invalid migration fence");
  const key = scope.prefix + "head", current = await jsonRecord<SavedHead>(scope.bucket, key);
  if (!current || current.value.revision !== body.revision) return json({ error: "head_changed" }, 409);
  if (current.value.fence && current.value.fence !== body.fence) return json({ error: "other_migration" }, 409);
  if ((release && !current.value.fence) || (!release && current.value.fence === body.fence)) return json(versionOf(current.value));
  const next = release ? versionOf(current.value) : { ...versionOf(current.value), fence: body.fence };
  const wrote = await scope.bucket.put(key, JSON.stringify(next), { onlyIf: { etagMatches: current.etag } });
  return wrote ? json(next) : json({ error: "head_changed" }, 409);
}

async function commit(scope: Scope, request: Request): Promise<Response> {
  const value = parse(await payload(request, 2048));
  if (!exact(value, ["parent", "manifest"]) || !(value.parent === null || validHash(value.parent)) || !(value.manifest === null || validHash(value.manifest))) return invalid("Invalid publication");
  const { parent, manifest } = value;
  const revision = await digest(JSON.stringify([1,parent,manifest]));
  const next: WorkFolderHead = { revision, parent, manifest, state: manifest === null ? "tombstone" : "live" };
  const key = scope.prefix + "head", current = await jsonRecord<SavedHead>(scope.bucket, key);
  if (current?.value.revision === revision) {
    if (!await registerFolder(scope.bucket, homePrefix(scope.stable) + "work-folders/", scope.owner + "/" + scope.folderId)) return json({ error: "folder_creation_frozen" }, 423);
    return json(next);
  }
  const priorKey = scope.prefix + "versions/" + revision;
  if (await scope.bucket.head(priorKey)) return json(next);
  if (current?.value.fence) return json({ error: "folder_in_migration" }, 423);
  if ((current?.value.revision ?? null) !== parent) return json({ error: "head_changed", current: current?.value ?? null }, 409);
  if (manifest !== null && (await summary(scope, manifest)).self.of !== "root") return invalid("Expected a directory root");
  if (!current && !await registerFolder(scope.bucket, homePrefix(scope.stable) + "work-folders/", scope.owner + "/" + scope.folderId)) return json({ error: "folder_creation_frozen" }, 423);
  if (current) await immutable(scope.bucket, scope.prefix + "versions/" + current.value.revision, JSON.stringify(versionOf(current.value)), "application/json");
  const data = JSON.stringify(next);
  const wrote = await scope.bucket.put(key, data, { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" } });
  if (!wrote) {
    const other = await jsonRecord<WorkFolderHead>(scope.bucket, key);
    if (other?.value.revision === revision || await scope.bucket.head(priorKey)) return json(next);
    return json({ error: "head_changed", current: other?.value ?? null }, 409);
  }
  await immutable(scope.bucket, priorKey, data, "application/json");
  return json(next, 201);
}

async function storeObject(scope: Scope, route: "blobs" | "manifests", id: string, data: Uint8Array): Promise<void> {
  if (await digest(data) !== id) throw new FolderError(422, "checksum_mismatch");
  if (route === "blobs") {
    await immutable(scope.bucket, scope.prefix + route + "/" + id, data, "application/octet-stream");
    return;
  }
  const info = await validateNode(scope, parse(data));
  await immutable(scope.bucket, scope.prefix + route + "/" + id, data, "application/json");
  await immutable(scope.bucket, scope.prefix + "summaries/" + id, JSON.stringify(info), "application/json");
}

async function migrateBatch(scope: Scope, request: Request): Promise<Response> {
  const batch = parse(await payload(request, WORK_FOLDER_BLOB_BYTES));
  if (!exact(batch, ["op", "objects"]) || !(batch.op === "verify" || batch.op === "put") || !Array.isArray(batch.objects) || !batch.objects.length || batch.objects.length > 64) return invalid("Invalid migration batch");
  const items = batch.objects;
  for (let offset = 0; offset < items.length; offset += 4) {
    await Promise.all(items.slice(offset, offset + 4).map(async item => {
      if (!record(item) || !(item.kind === "blobs" || item.kind === "manifests") || !validHash(item.sha256)) return invalid("Invalid migration item");
      if (batch.op === "verify") {
        if (!exact(item, ["kind", "sha256"])) return invalid("Invalid verification item");
        const row = await scope.bucket.get(scope.prefix + item.kind + "/" + item.sha256);
        if (!row) throw new FolderError(404, "Missing verification object");
        if (await sha256Stream(row.body) !== item.sha256) throw new FolderError(422, "Stored work object checksum differs");
      } else {
        if (!exact(item, ["kind", "sha256", "base64"]) || typeof item.base64 !== "string") return invalid("Invalid migration content");
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(item.base64), c => c.charCodeAt(0)); }
        catch { return invalid("Invalid migration encoding"); }
        await storeObject(scope, item.kind, item.sha256, bytes);
      }
    }));
  }
  return json({ verified: items.map(i => i.sha256) });
}

export async function handleWorkFolder(request: Request, bucket: WorkFolderBucket, stableId: string, origin: string, bootstrap: string, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== origin || !url.pathname.startsWith(WORK_FOLDER_ROUTE)) return absent();
  const [botId, folderId, route, id, ...rest] = url.pathname.slice(WORK_FOLDER_ROUTE.length).split("/");
  if (!botId || !folderId || !validWorkFolderScope(botId, folderId) || rest.length || !route) return absent();
  const scope: Scope = { stable: stableId, owner: botId, folderId, prefix: homePrefix(stableId) + "work-folders/v1/" + botId + "/" + folderId + "/", baseUrl: workFolderBaseUrl(origin, botId, folderId), authority: await workFolderAuthority(bootstrap, botId, folderId), bucket, now };
  const token = /^Bearer (\S{1,512})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    if (route === "refresh" && !id && request.method === "POST") {
      const match = await guest(scope, token, true);
      return match ? json(await issued(scope, match.guestId, match.generation)) : json({ error: "unauthorized" }, 401);
    }
    const owner = token.startsWith("wfa_") && await sameToken(token, scope.authority);
    if (!owner && !await guest(scope, token, false)) return json({ error: "unauthorized" }, 401);
    if (route === "grant" || route === "revoke") return !id && request.method === "POST" && owner ? await grant(scope, request, route === "revoke") : json({ error: "forbidden" }, 403);
    if ((route === "fence" || route === "unfence") && !id) return owner && request.method === "POST" ? await folderFence(scope, request, route === "unfence") : json({ error: "forbidden" }, 403);
    if (route === "batch" && !id) return owner && request.method === "POST" ? await migrateBatch(scope, request) : json({ error: "forbidden" }, 403);
    if (route === "commit" && !id && request.method === "POST") {
      if (!owner && (await readWorkFolderPlacement(bucket, stableId))?.mode === "legacy") return json({ error: "legacy_work_folder" }, 423);
      return await commit(scope, request);
    }
    if (route === "head" && !id && request.method === "GET") {
      const head = await jsonRecord<WorkFolderHead>(bucket, scope.prefix + "head");
      return head ? json(head.value) : json({ error: "never_published" }, 404);
    }
    if (!validHash(id)) return absent();
    if (route === "versions" && request.method === "GET") {
      const held = await jsonRecord<WorkFolderHead>(bucket, scope.prefix + "versions/" + id);
      if (held) return json(held.value);
      const current = await jsonRecord<WorkFolderHead>(bucket, scope.prefix + "head");
      return current?.value.revision === id ? json(current.value) : absent();
    }
    if (route === "ranges" && request.method === "GET") {
      const held = await jsonRecord<Summary>(bucket, scope.prefix + "summaries/" + id);
      return held ? json(held.value) : absent();
    }
    if (route !== "manifests" && route !== "blobs") return absent();
    const key = scope.prefix + route + "/" + id;
    if (request.method === "HEAD") {
      const obj = await bucket.head(key);
      return obj ? new Response(null, { headers: { "content-length": String(obj.size), etag: '"' + id + '"' } }) : absent();
    }
    if (request.method === "GET") {
      const obj = await bucket.get(key);
      return obj ? new Response(obj.body, { headers: { "content-length": String(obj.size), "content-type": route === "blobs" ? "application/octet-stream" : "application/json", etag: '"' + id + '"', "cache-control": "private, no-store" } }) : absent();
    }
    if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
    const data = await payload(request, WORK_FOLDER_BLOB_BYTES);
    await storeObject(scope, route, id, data);
    return new Response(null, { status: 201 });
  } catch (e) {
    if (e instanceof FolderError) return json({ error: e.message }, e.status);
    throw e;
  }
}
