import { createHash } from "node:crypto";
import { chmod, lchown, lstat, mkdir, open, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MANIFEST_VERSION = 1;
const SQLITE = /\.(?:sqlite3?|db)$/;
const SKIPPED_NAMES = new Set(["node_modules", ".cache", ".npm", ".pnpm-store", "Cache", "Code Cache", "GPUCache", "ShaderCache", "Crashpad", ".Trash", "lost+found"]);
const SKIPPED_SUFFIXES = ["-wal", "-shm", "-journal"];
const HASH = /^[a-f0-9]{64}$/;

export function skipped(name) {
  return SKIPPED_NAMES.has(name) || SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function createHttpStore(baseUrl, token, fetcher = globalThis.fetch) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}` };
  const call = async (path, init = {}) => {
    const response = await fetcher(`${base}/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    return response;
  };
  return {
    async manifest() {
      const response = await call("manifest.json");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`manifest read failed: ${response.status}`);
      return parseManifest(await response.json());
    },
    async putManifest(manifest) {
      const response = await call("manifest.json", { method: "PUT", body: JSON.stringify(manifest) });
      if (!response.ok) throw new Error(`manifest write failed: ${response.status}`);
    },
    async has(hash) {
      const response = await call(`blobs/${hash}`, { method: "HEAD" });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`blob check failed: ${response.status}`);
      return true;
    },
    async get(hash) {
      const response = await call(`blobs/${hash}`);
      if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async put(hash, bytes) {
      const response = await call(`blobs/${hash}`, { method: "PUT", body: bytes });
      if (!response.ok) throw new Error(`blob write failed: ${response.status}`);
    },
    async listBlobs(cursor) {
      const response = await call(`blobs/${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!response.ok) throw new Error(`blob list failed: ${response.status}`);
      const page = await response.json();
      return { hashes: Array.isArray(page?.hashes) ? page.hashes.filter((hash) => HASH.test(hash)) : [], ...(typeof page?.cursor === "string" ? { cursor: page.cursor } : {}) };
    },
    async deleteBlob(hash) {
      const response = await call(`blobs/${hash}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`blob delete failed: ${response.status}`);
    },
  };
}

export function parseManifest(input) {
  if (!input || input.version !== MANIFEST_VERSION || !Array.isArray(input.entries)) throw new Error("unreadable manifest");
  for (const entry of input.entries) {
    if (typeof entry?.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error("unsafe manifest path");
    if (!["dir", "file", "link"].includes(entry.type)) throw new Error("unknown manifest entry");
    if (entry.type === "file" && !(Array.isArray(entry.chunks) && entry.chunks.every((hash) => HASH.test(hash)))) throw new Error("bad manifest chunks");
    if (entry.type === "link" && typeof entry.target !== "string") throw new Error("bad manifest link");
  }
  return input;
}

async function walk(root, directory, found) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (skipped(name)) continue;
    const path = join(directory, name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    const entry = { path: relative(root, path), mode: info.mode & 0o7777, mtimeMs: Math.floor(info.mtimeMs) };
    if (info.isDirectory()) {
      found.push({ ...entry, type: "dir" });
      await walk(root, path, found);
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target: await readlink(path) });
    } else if (info.isFile()) {
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export async function scan(root) {
  const found = [];
  await walk(root, root, found);
  return found;
}

async function chunksOf(path, store) {
  const handle = await open(path, "r");
  const chunks = [];
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (!(await store.has(hash))) await store.put(hash, Buffer.from(bytes));
      chunks.push(hash);
      if (bytesRead < CHUNK_BYTES) break;
    }
  } finally {
    await handle.close();
  }
  return chunks;
}

async function databaseStamp(path, entry) {
  const wal = await lstat(`${path}-wal`).catch(() => null);
  return `${entry.size}:${entry.mtimeMs}:${wal?.size ?? 0}:${wal ? Math.floor(wal.mtimeMs) : 0}`;
}

async function databaseCopy(path, scratch) {
  const copy = join(scratch, `${createHash("sha256").update(path).digest("hex")}.sqlite`);
  await rm(copy, { force: true });
  const source = new DatabaseSync(path);
  try {
    await backup(source, copy);
  } finally {
    source.close();
  }
  return copy;
}

export async function snapshot(root, store, previous, { scratch, now = Date.now } = {}) {
  const known = new Map((previous?.entries ?? []).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const entries = [];
  let uploaded = 0;
  if (scratch) await mkdir(scratch, { recursive: true, mode: 0o700 });
  for (const entry of await scan(root)) {
    if (entry.type !== "file") {
      entries.push(entry);
      continue;
    }
    const before = known.get(entry.path);
    const database = SQLITE.test(entry.path);
    const stamp = database ? await databaseStamp(join(root, entry.path), entry) : undefined;
    if (before && before.size === entry.size && before.mtimeMs === entry.mtimeMs && before.stamp === stamp) {
      entries.push({ ...entry, ...(stamp ? { stamp } : {}), chunks: before.chunks });
      continue;
    }
    try {
      const source = database && scratch ? await databaseCopy(join(root, entry.path), scratch) : join(root, entry.path);
      const chunks = await chunksOf(source, store);
      if (source !== join(root, entry.path)) await rm(source, { force: true });
      entries.push({ ...entry, ...(stamp ? { stamp } : {}), chunks });
      uploaded += 1;
    } catch (error) {
      if (before) entries.push(before);
      else if (error?.code !== "ENOENT") throw error;
    }
  }
  const manifest = { version: MANIFEST_VERSION, createdAt: now(), entries };
  if (uploaded > 0 || !previous || previous.entries.length !== entries.length || changedShape(previous.entries, entries)) {
    await store.putManifest(manifest);
    return { manifest, written: true, uploaded };
  }
  return { manifest: previous, written: false, uploaded };
}

function changedShape(before, after) {
  for (let index = 0; index < after.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left.path !== right.path || left.type !== right.type || left.mode !== right.mode || left.target !== right.target) return true;
  }
  return false;
}

const RESTORE_PARALLEL = 16;

export async function restore(root, store, owner) {
  const manifest = await store.manifest();
  if (!manifest) return { manifest: null, files: 0 };
  let files = 0;
  const own = async (path) => {
    if (owner) await lchown(path, owner.uid, owner.gid);
  };
  for (const entry of manifest.entries) {
    if (entry.type !== "dir") continue;
    const path = join(root, entry.path);
    await mkdir(path, { recursive: true, mode: entry.mode });
    await own(path);
  }
  for (const entry of manifest.entries) {
    if (entry.type !== "link") continue;
    const path = join(root, entry.path);
    await rm(path, { force: true, recursive: true });
    await symlink(entry.target, path);
    await own(path);
  }
  const pending = manifest.entries.filter((entry) => entry.type !== "dir" && entry.type !== "link");
  const writeOne = async (entry) => {
    const path = join(root, entry.path);
    const parts = [];
    for (const hash of entry.chunks) {
      const bytes = await store.get(hash);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`corrupt chunk for ${entry.path}`);
      parts.push(bytes);
    }
    await rm(path, { force: true, recursive: true });
    await writeFile(path, Buffer.concat(parts), { mode: entry.mode });
    await chmod(path, entry.mode);
    await own(path);
    const moment = new Date(entry.mtimeMs);
    await utimes(path, moment, moment);
    files += 1;
  };
  let next = 0;
  const worker = async () => {
    while (next < pending.length) await writeOne(pending[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(RESTORE_PARALLEL, pending.length) }, worker));
  for (const entry of [...manifest.entries].reverse()) {
    if (entry.type !== "dir") continue;
    const moment = new Date(entry.mtimeMs);
    await utimes(join(root, entry.path), moment, moment).catch(() => undefined);
    await chmod(join(root, entry.path), entry.mode).catch(() => undefined);
  }
  return { manifest, files };
}

export function referencedBlobs(manifest) {
  const keep = new Set();
  for (const entry of manifest?.entries ?? []) if (entry.type === "file") for (const hash of entry.chunks) keep.add(hash);
  return keep;
}

export async function collectGarbage(store, manifest) {
  if (!manifest) return 0;
  const keep = referencedBlobs(manifest);
  const unused = [];
  let cursor;
  do {
    const page = await store.listBlobs(cursor);
    for (const hash of page.hashes) if (!keep.has(hash)) unused.push(hash);
    cursor = page.cursor;
  } while (cursor);
  for (const hash of unused) await store.deleteBlob(hash);
  return unused.length;
}
