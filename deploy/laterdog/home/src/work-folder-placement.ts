import { registeredPage, registryFence, verifiedMembership } from "./work-folder-registry.ts";
import { workFolderLayoutRecord, workFolderPlacementSchema, type WorkFolderLayout, type WorkFolderPlacement } from "../../../../shared/work-folder-layout.ts";
import { hex, sha256, sha256Stream } from "./encoding.ts";
import { homePrefix } from "./state.ts";
import type { WorkFolderBucket } from "./work-folder-store.ts";

const hash = /^[a-f0-9]{64}$/;
const registered = "/work-folders/scopes";
const registryLock = /^\/work-folders\/registry-(unfence|fence)$/;
const placement = "/work-folders/placement";
const evidence = /^\/work-folders\/verification\/([a-f0-9]{64})$/;
const legacySnapshot = /^\/work-folders\/legacy-manifests\/([a-f0-9]{64})$/;
const projection = "/work-folders/project-legacy";
const legacyBlobs = "/work-folders/project-blobs";
const history = /^\/work-folders\/placements\/([a-f0-9]{64})$/;
const result = (value: unknown, status: number) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const checksum = async (value: string | Uint8Array) => hex(await sha256(value));

export function workFolderControlPath(path: string): boolean {
  return path === placement || path === registered || registryLock.test(path) || path === projection || path === legacyBlobs || legacySnapshot.test(path) || evidence.test(path) || history.test(path);
}

export async function readWorkFolderPlacement(bucket: WorkFolderBucket, stable: string): Promise<WorkFolderPlacement | null> {
  const object = await bucket.get(homePrefix(stable) + placement.slice(1));
  if (!object) return null;
  return workFolderPlacementSchema.parse(await new Response(object.body).json());
}

export async function eligibleSharedFolder(layout: WorkFolderLayout, owner: string, folderId: string, grantee: string): Promise<boolean> {
  if (folderId === "loose") return Boolean(layout.loose && layout.loose.owner === owner && layout.loose.members.includes(grantee));
  if (!folderId.startsWith("project-")) return false;
  for (const p of layout.projects) {
    if (p.path !== "/data" && p.owner === owner && p.members.includes(grantee) && folderId === "project-" + await checksum(p.path)) return true;
  }
  return false;
}

export async function layoutScopes(layout: WorkFolderLayout): Promise<string[]> {
  const scopes = layout.dogs.map(d => d + "/dog");
  for (const [dog, tasks] of Object.entries(layout.tasks)) for (const t of tasks) scopes.push(dog + "/task-" + t);
  for (const p of layout.projects) {
    if (p.path !== "/data") scopes.push(p.owner + "/project-" + await checksum(p.path));
  }
  if (layout.loose) scopes.push(layout.loose.owner + "/loose");
  return [...new Set(scopes)].sort();
}

interface ScopeProof {
  scope: string;
  revision: string;
  manifest: string | null;
  sourceTree: string;
  restoredTree: string;
}

export interface WorkFolderVerification {
  v: 1;
  mode: "folders" | "legacy";
  baselineManifest: string;
  layoutSha256: string;
  scopes: ScopeProof[];
}

function proof(value: unknown): value is WorkFolderVerification {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<WorkFolderVerification>;
  return v.v === 1 && (v.mode === "folders" || v.mode === "legacy") && hash.test(v.baselineManifest ?? "") && hash.test(v.layoutSha256 ?? "") && Array.isArray(v.scopes) && v.scopes.every(s =>
    s && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s.scope) && hash.test(s.revision)
    && (s.manifest === null || hash.test(s.manifest)) && hash.test(s.sourceTree) && s.sourceTree === s.restoredTree);
}

async function checked(scope: string, bucket: WorkFolderBucket, next: WorkFolderPlacement, baseline = true): Promise<boolean> {
  const object = await bucket.get(scope + "work-folders/verification/" + next.verification);
  if (!object) return false;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (await checksum(bytes) !== next.verification) return false;
  const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!proof(v) || next.mode !== v.mode || next.baselineManifest !== v.baselineManifest || await checksum(workFolderLayoutRecord(next.layout)) !== v.layoutSha256) return false;
  const expected = await layoutScopes(next.layout), claims = [...v.scopes].sort((a,b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0);
  if (expected.length !== claims.length || expected.some((s,i) => s !== claims[i]?.scope)) return false;
  if (!await verifiedMembership(bucket, scope + "work-folders/", expected, next.verification)) return false;
  for (let i = 0; i < claims.length; i += 16) {
    const matched = await Promise.all(claims.slice(i, i + 16).map(async claim => {
      const head = await bucket.get(scope + "work-folders/v1/" + claim.scope + "/head");
      if (!head) return false;
      const live = await new Response(head.body).json() as { revision?: string; manifest?: string | null; fence?: string };
      return live.revision === claim.revision && live.manifest === claim.manifest && live.fence === next.verification;
    }));
    if (matched.includes(false)) return false;
  }
  if (!baseline) return true;
  const current = await bucket.get(scope + "manifest.json");
  if (!current) return false;
  return await sha256Stream(current.body) === v.baselineManifest;
}

async function bytesOf(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let n = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > 8 * 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const b of chunks) { bytes.set(b, at); at += b.length; }
  return bytes;
}

async function pinLegacy(bucket: WorkFolderBucket, scope: string, sha: string): Promise<void> {
  const key = scope + "work-folders/legacy-manifests/" + sha;
  if (await bucket.head(key)) return;
  const current = await bucket.get(scope + "manifest.json");
  if (!current) throw new Error("Missing legacy home manifest");
  await bucket.put(key, current.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: sha, httpMetadata: { contentType: "application/json" } });
}

async function projectLegacy(request: Request, bucket: WorkFolderBucket, scope: string): Promise<Response> {
  const data = await bytesOf(request);
  if (!data) return result({ error: "oversized_request" }, 413);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(data)); } catch { return result({ error: "invalid_projection" }, 400); }
  const proposed = workFolderPlacementSchema.safeParse(body?.placement);
  if (!proposed.success || proposed.data.mode !== "legacy" || !hash.test(body?.source ?? "")) return result({ error: "invalid_projection" }, 400);
  const next = proposed.data;
  const current = await bucket.get(scope + "manifest.json");
  const placed = await bucket.get(scope + "work-folders/placement");
  if (!current || !placed || await sha256Stream(placed.body) !== next.previous) return result({ error: "placement_changed" }, 409);
  const currentHash = await sha256Stream(current.body);
  if (currentHash === next.baselineManifest) return result({ revision: currentHash }, 200);
  if (currentHash !== body.source || request.headers.get("if-match") !== '"' + current.etag + '"') return result({ error: "legacy_changed" }, 409);
  if (!await checked(scope, bucket, next, false)) return result({ error: "unverified_projection" }, 422);
  const restored = await bucket.get(scope + "work-folders/legacy-manifests/" + next.baselineManifest);
  if (!restored) return result({ error: "missing_reconstructed_manifest" }, 422);
  await pinLegacy(bucket, scope, body.source);
  const saved = await bucket.put(scope + "manifest.json", restored.body, { onlyIf: { etagMatches: current.etag }, sha256: next.baselineManifest, httpMetadata: { contentType: "application/json" } });
  return saved ? result({ revision: next.baselineManifest }, 201) : result({ error: "legacy_changed" }, 409);
}

async function projectBlobs(request: Request, bucket: WorkFolderBucket, prefix: string): Promise<Response> {
  const data = await bytesOf(request);
  if (!data) return result({ error: "oversized_request" }, 413);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(data)); } catch { return result({ error: "invalid_projection" }, 400); }
  if (!body || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.scope) || !Array.isArray(body.hashes) || body.hashes.length > 64 || !body.hashes.every((h: unknown) => typeof h === "string" && hash.test(h))) return result({ error: "invalid_projection" }, 400);
  for (let i = 0; i < body.hashes.length; i += 4) {
    const copied = await Promise.all((body.hashes.slice(i, i + 4) as string[]).map(async id => {
      const destination = prefix + "blobs/" + id;
      const present = await bucket.get(destination);
      if (present) return await sha256Stream(present.body) === id;
      const original = await bucket.get(prefix + "work-folders/v1/" + body.scope + "/blobs/" + id);
      if (!original) return false;
      await bucket.put(destination, original.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: id });
      const readback = await bucket.get(destination);
      return readback && await sha256Stream(readback.body) === id;
    }));
    if (copied.some(ok => !ok)) return result({ error: "legacy_blob_missing_or_corrupt" }, 422);
  }
  return result({ verified: body.hashes }, 200);
}

export async function handleWorkFolderPlacement(request: Request, bucket: WorkFolderBucket, stable: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!workFolderControlPath(path)) return result({ error: "not_found" }, 404);
  const scope = homePrefix(stable), key = scope + path.slice(1);
  if (path === registered) {
    if (request.method !== "GET") return result({ error: "method_not_allowed" }, 405);
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && !hash.test(cursor)) return result({ error: "invalid_cursor" }, 400);
    return result(await registeredPage(bucket, scope + "work-folders/", cursor), 200);
  }
  const lock = registryLock.exec(path)?.[1];
  if (lock) {
    if (request.method !== "POST") return result({ error: "method_not_allowed" }, 405);
    const data = await bytesOf(request);
    if (!data) return result({ error: "oversized_request" }, 413);
    let b;
    try { b = JSON.parse(new TextDecoder().decode(data)); } catch { return result({ error: "invalid_registry_fence" }, 400); }
    if (!b || b.revision !== null && !hash.test(b.revision ?? "") || !hash.test(b.fence ?? "")) return result({ error: "invalid_registry_fence" }, 400);
    return await registryFence(bucket, scope + "work-folders/", b, lock === "unfence") ? result({ revision: b.revision }, 200) : result({ error: "registry_changed" }, 409);
  }
  if (path === projection) return request.method === "POST" ? projectLegacy(request, bucket, scope) : result({ error: "method_not_allowed" }, 405);
  if (path === legacyBlobs) return request.method === "POST" ? projectBlobs(request, bucket, scope) : result({ error: "method_not_allowed" }, 405);
  const snapshot = legacySnapshot.exec(path)?.[1];
  if (snapshot && request.method === "PUT" && request.body) {
    await bucket.put(key, request.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: snapshot, httpMetadata: { contentType: "application/json" } });
    const found = await bucket.get(key);
    if (!found || await sha256Stream(found.body) !== snapshot) return result({ error: "snapshot_checksum_mismatch" }, 422);
    return result({ revision: snapshot }, 201);
  }
  if (request.method === "GET") {
    const obj = await bucket.get(key);
    return obj ? new Response(obj.body, { headers: { etag: '"' + obj.etag + '"', "content-type": "application/json", "cache-control": "no-store" } }) : result({ error: "not_found" }, 404);
  }
  if (request.method !== "PUT" || history.test(path)) return result({ error: "method_not_allowed" }, 405);
  const data = await bytesOf(request);
  if (!data) return result({ error: "oversized_control_document" }, 413);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(data)); } catch { return result({ error: "invalid_json" }, 400); }
  const id = await checksum(data), options = { httpMetadata: { contentType: "application/json" } };
  const evidenceId = evidence.exec(path)?.[1];
  if (evidenceId) {
    if (id !== evidenceId || !proof(value)) return result({ error: "invalid_verification" }, 422);
    await bucket.put(key, data, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
    return result({ revision: id }, 201);
  }
  const parsed = workFolderPlacementSchema.safeParse(value);
  if (!parsed.success) return result({ error: "invalid_placement" }, 422);
  const old = await bucket.get(key), oldBytes = old ? new Uint8Array(await new Response(old.body).arrayBuffer()) : null;
  const previous = oldBytes && await checksum(oldBytes);
  if (id === previous) return result({ revision: id }, 200);
  if (parsed.data.previous !== previous || (old ? request.headers.get("if-match") !== '"' + old.etag + '"' : request.headers.get("if-none-match") !== "*")) return result({ error: "placement_changed" }, 409);
  if (!await checked(scope, bucket, parsed.data)) return result({ error: "unverified_placement" }, 422);
  await pinLegacy(bucket, scope, parsed.data.baselineManifest);
  if (oldBytes && previous) await bucket.put(scope + "work-folders/placements/" + previous, oldBytes, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
  const wrote = await bucket.put(key, data, { ...options, onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: "*" } });
  if (!wrote) return result({ error: "placement_changed" }, 409);
  await bucket.put(scope + "work-folders/placements/" + id, data, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
  return result({ revision: id }, 201);
}
