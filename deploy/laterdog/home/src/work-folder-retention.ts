import { hex, sha256, sha256Stream } from "./encoding.ts";
import type { WorkFolderBucket } from "./work-folder-store.ts";

const objectId = /^[a-f0-9]{64}$/;
const pageSize = 64;
const identity = (kind: string, ids: string[]) => sha256(JSON.stringify([kind, ids])).then(hex);
const reply = (error: string, status: number) => Response.json({ error }, { status });

export const LEGACY_RETENTION = "work-folders/legacy-retention";
export const legacyHoldRoute = /^\/work-folders\/retention\/(leaf|branch|seal|repair)\/([a-f0-9]{64})$/;

async function* chunkReferences(input: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = input.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let quoted = false, escaped = false, candidate = "", overflow = false;
  let state: "open" | "colon" | "array" | "hashes" = "open";
  try {
    for (;;) {
      const part = await reader.read();
      const text = part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      for (const c of text) {
        if (quoted) {
          if (!escaped && c === '"') {
            quoted = false;
            const token = overflow ? null : JSON.parse('"' + candidate + '"') as string;
            if (state === "hashes") {
              if (token === null || !objectId.test(token)) throw new Error("Invalid saved blob reference");
              yield token;
            } else state = token === "chunks" ? "colon" : "open";
          } else {
            if (!overflow) {
              candidate += c;
              overflow = candidate.length > 384;
            }
            escaped = !escaped && c === "\\";
          }
        } else if (c === '"') {
          quoted = true;
          candidate = "";
          overflow = escaped = false;
        } else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") {
          if (state === "hashes") {
            if (c === "]") state = "open";
            else if (c !== ",") throw new Error("Invalid saved chunk array");
          } else if (state === "colon" && c === ":") state = "array";
          else if (state === "array" && c === "[") state = "hashes";
          else state = "open";
        }
      }
      if (part.done) break;
    }
    if (quoted || state === "hashes") throw new Error("Truncated legacy snapshot");
  } finally { reader.releaseLock(); }
}

async function referenceRoot(input: ReadableStream<Uint8Array>): Promise<string> {
  let level: string[] = [], leaf: string[] = [];
  for await (const id of chunkReferences(input)) {
    leaf.push(id);
    if (leaf.length === pageSize) {
      level.push(await identity("leaf", leaf));
      leaf = [];
    }
  }
  if (leaf.length || !level.length) level.push(await identity("leaf", leaf));
  while (level.length > 1) {
    const parents: string[] = [];
    for (let n = 0; n < level.length; n += pageSize) parents.push(await identity("branch", level.slice(n, n + pageSize)));
    level = parents;
  }
  return level[0]!;
}

async function ensureCopy(bucket: WorkFolderBucket, source: string, destination: string, hash: string): Promise<boolean> {
  const kept = await bucket.get(destination);
  if (kept) return await sha256Stream(kept.body) === hash;
  const object = await bucket.get(source);
  if (!object) return false;
  await bucket.put(destination, object.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: hash });
  const latest = await bucket.get(destination);
  return Boolean(latest && await sha256Stream(latest.body) === hash);
}

export async function handleLegacyHold(request: Request, bucket: WorkFolderBucket, prefix: string, mode: string, hash: string): Promise<Response> {
  if (request.method !== "POST") return reply("method_not_allowed", 405);
  if (Number(request.headers.get("content-length") ?? 0) > 8192) return reply("batch_too_large", 413);
  const info = await new Response(request.body).text();
  if (info.length > 8192) return reply("batch_too_large", 413);
  let body;
  try { body = JSON.parse(info); } catch { return reply("invalid_request", 400); }
  const base = prefix + "work-folders/legacy-";
  if (mode === "seal") {
    const root = body?.root;
    if (typeof root !== "string" || !objectId.test(root) || !await bucket.head(base + "nodes/" + root)) return reply("unverified_snapshot", 422);
    const manifest = await bucket.get(base + "manifests/" + hash);
    if (!manifest || await referenceRoot(manifest.body) !== root) return reply("snapshot_closure_differs", 422);
    await bucket.put(base + "seals/" + hash, root, { onlyIf: { etagDoesNotMatch: "*" } });
    return Response.json({ revision: hash, root });
  }
  const ids = body?.hashes;
  if (!Array.isArray(ids) || ids.length > pageSize || !ids.every(h => typeof h === "string" && objectId.test(h))) return reply("invalid_references", 400);
  const kind = mode === "repair" ? "leaf" : mode;
  if (await identity(kind, ids) !== hash || mode === "branch" && !ids.length) return reply("page_checksum_differs", 422);
  if (mode !== "repair" && await bucket.head(base + "nodes/" + hash)) return Response.json({ revision: hash });
  if (mode === "repair" && !await bucket.head(base + "nodes/" + hash)) return reply("unverified_recovery_page", 422);
  for (let i = 0; i < ids.length; i += 8) {
    const passed = await Promise.all(ids.slice(i, i + 8).map(async id => {
      if (mode === "branch") return Boolean(await bucket.head(base + "nodes/" + id));
      const active = prefix + "blobs/" + id, retained = base + "blobs/" + id;
      return mode === "repair" ? ensureCopy(bucket, retained, active, id) : ensureCopy(bucket, active, retained, id);
    }));
    if (passed.includes(false)) return reply("missing_or_corrupt_legacy_blob", 422);
  }
  if (mode !== "repair") await bucket.put(base + "nodes/" + hash, JSON.stringify([kind, ids]), { onlyIf: { etagDoesNotMatch: "*" } });
  return Response.json({ revision: hash });
}
