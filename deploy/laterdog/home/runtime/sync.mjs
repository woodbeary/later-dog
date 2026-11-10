import { createHash } from "node:crypto";
import { chmod, lchown, lstat, mkdir, open, readdir, readlink, rename, rm, statfs, symlink, utimes } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MANIFEST_VERSION = 1;
export const BLOB_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 120_000;
export const FINAL_SAVE_MS = 120_000;
export const SNAPSHOT_RESERVE_BYTES = 256 * 1024 * 1024;
const RESTORING_PREFIX = ".laterdog-restoring-";
const SQLITE = /\.(?:sqlite3?|db)$/;
const SKIPPED_NAMES = new Set(["node_modules", ".cache", ".tmp", ".npm", ".pnpm-store", "Cache", "Code Cache", "GPUCache", "ShaderCache", "Crashpad", ".Trash", "lost+found"]);
const SKIPPED_SUFFIXES = ["-wal", "-shm", "-journal"];
const SKIPPED_PATHS = [".local/share/pnpm"];
const REFRESH_LOCK_NAMES = new Set([".oauth_refresh.lock", ".oauth_refresh.lock.owner"]);
const LOCK_DIRECTORY_SUFFIX = ".lock";
const HASH = /^[a-f0-9]{64}$/;
const RESTORE_POINT_NAME = /^\d{1,16}\.json$/;

export class StoreRefused extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function restorePointAge(name) {
  return Number(name.slice(0, -".json".length));
}

export function skipped(name) {
  return SKIPPED_NAMES.has(name) || REFRESH_LOCK_NAMES.has(name) || name.startsWith(RESTORING_PREFIX) || SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function skippedPath(path) {
  return SKIPPED_PATHS.some((skippedRoot) => path === skippedRoot || path.startsWith(`${skippedRoot}/`));
}

export function heldLock(name, type) {
  return type === "dir" && name.endsWith(LOCK_DIRECTORY_SUFFIX);
}

export function transient(entry) {
  const names = entry.path.split("/");
  return skippedPath(entry.path) || names.some((name, index) => skipped(name) || heldLock(name, index < names.length - 1 ? "dir" : entry.type));
}

export function createHttpStore(baseUrl, token, fetcher = globalThis.fetch, { blobTimeoutMs = BLOB_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}` };
  const call = async (path, init = {}, timeoutMs = requestTimeoutMs) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetcher(`${base}/${path}`, { ...init, signal, headers: { ...headers, ...init.headers } });
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
    async get(hash, { signal } = {}) {
      const response = await call(`blobs/${hash}`, signal ? { signal } : {}, blobTimeoutMs);
      if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async put(hash, bytes) {
      const response = await call(`blobs/${hash}`, { method: "PUT", body: bytes }, uploadTimeoutMs);
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
    async restorePoints() {
      const response = await call("restore-points/");
      if (!response.ok) throw new StoreRefused(`restore point list failed: ${response.status}`, response.status);
      const page = await response.json();
      const names = Array.isArray(page?.names) ? page.names.filter((name) => RESTORE_POINT_NAME.test(name)) : [];
      return names.sort((left, right) => restorePointAge(left) - restorePointAge(right));
    },
    async restorePoint(name) {
      const response = await call(`restore-points/${name}`);
      if (!response.ok) throw new StoreRefused(`restore point read failed: ${response.status}`, response.status);
      return parseManifest(await response.json());
    },
    async putRestorePoint(name, manifest) {
      const response = await call(`restore-points/${name}`, { method: "PUT", body: JSON.stringify(manifest) });
      if (!response.ok) throw new StoreRefused(`restore point write failed: ${response.status}`, response.status);
    },
    async devCode() {
      const response = await call("dev-code.json");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`dev code read failed: ${response.status}`);
      const pointer = await response.json().catch(() => null);
      return typeof pointer?.hash === "string" && HASH.test(pointer.hash) ? { hash: pointer.hash, ...(typeof pointer.label === "string" ? { label: pointer.label } : {}) } : null;
    },
    async devBundle(hash) {
      const response = await call(`dev-code/${hash}.tgz`, {}, blobTimeoutMs);
      if (!response.ok) throw new Error(`dev code bundle read failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async archiveIndex() {
      const response = await call("archive/index.json");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`archive index read failed: ${response.status}`);
      return await response.json();
    },
    async putArchiveIndex(index) {
      const response = await call("archive/index.json", { method: "PUT", body: JSON.stringify(index) });
      if (!response.ok) throw new Error(`archive index write failed: ${response.status}`);
    },
    async hasArchived(hash) {
      const response = await call(`archive/blobs/${hash}`, { method: "HEAD" });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`archive check failed: ${response.status}`);
      return true;
    },
    async getArchived(hash) {
      const response = await call(`archive/blobs/${hash}`, {}, blobTimeoutMs);
      if (!response.ok) throw new Error(`archive read failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async putArchived(hash, bytes) {
      const response = await call(`archive/blobs/${hash}`, { method: "PUT", body: bytes }, uploadTimeoutMs);
      if (!response.ok) throw new Error(`archive write failed: ${response.status}`);
    },
    async listArchived(cursor) {
      const response = await call(`archive/blobs/${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!response.ok) throw new Error(`archive list failed: ${response.status}`);
      const page = await response.json();
      return { hashes: Array.isArray(page?.hashes) ? page.hashes.filter((hash) => HASH.test(hash)) : [], ...(typeof page?.cursor === "string" ? { cursor: page.cursor } : {}) };
    },
    async deleteRestorePoint(name) {
      const response = await call(`restore-points/${name}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new StoreRefused(`restore point delete failed: ${response.status}`, response.status);
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
    if (skippedPath(relative(root, path))) continue;
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    const entry = { path: relative(root, path), mode: info.mode & 0o7777, mtimeMs: Math.floor(info.mtimeMs) };
    if (info.isDirectory()) {
      if (heldLock(name, "dir")) continue;
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

async function diskFree(path) {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

async function roomForCopy(path, entry, scratch, freeBytes) {
  const free = await Promise.resolve().then(() => freeBytes(scratch)).catch(() => null);
  if (typeof free !== "number" || !Number.isFinite(free)) return false;
  const wal = await lstat(`${path}-wal`).catch((error) => (error?.code === "ENOENT" ? { size: 0 } : null));
  if (!wal) return false;
  return free >= entry.size + wal.size + SNAPSHOT_RESERVE_BYTES;
}

async function databaseCopy(path, scratch) {
  const copy = join(scratch, `${createHash("sha256").update(path).digest("hex")}.sqlite`);
  await rm(copy, { force: true });
  const source = new DatabaseSync(path);
  try {
    await backup(source, copy);
  } catch (error) {
    await rm(copy, { force: true }).catch(() => {});
    throw error;
  } finally {
    source.close();
  }
  return copy;
}

export const SAVE_PARALLEL = 8;

export function walkOrder(left, right) {
  const leftNames = left.split("/");
  const rightNames = right.split("/");
  const shared = Math.min(leftNames.length, rightNames.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftNames[index] < rightNames[index]) return -1;
    if (leftNames[index] > rightNames[index]) return 1;
  }
  return leftNames.length - rightNames.length;
}

export function resumeOrder(waiting, resumeAfter) {
  if (resumeAfter === undefined) return waiting;
  const start = waiting.findIndex((item) => walkOrder(item.entry.path, resumeAfter) > 0);
  return start <= 0 ? waiting : [...waiting.slice(start), ...waiting.slice(0, start)];
}

export async function snapshot(root, store, previous, { scratch, now = Date.now, app, budgetMs = Infinity, freeBytes = diskFree, resumeAfter, parallel = SAVE_PARALLEL } = {}) {
  const known = new Map((previous?.entries ?? []).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const unsaved = [];
  let uploaded = 0;
  let deferred = 0;
  const deadline = now() + budgetMs;
  if (scratch) await mkdir(scratch, { recursive: true, mode: 0o700 });
  const scanned = await scan(root);
  const slots = Array.from({ length: scanned.length }, () => null);
  const waiting = [];
  for (const [index, entry] of scanned.entries()) {
    if (entry.type !== "file") {
      slots[index] = entry;
      continue;
    }
    const before = known.get(entry.path);
    const database = SQLITE.test(entry.path);
    const stamp = database ? await databaseStamp(join(root, entry.path), entry) : undefined;
    if (before && before.size === entry.size && before.mtimeMs === entry.mtimeMs && before.stamp === stamp) {
      slots[index] = { ...entry, ...(stamp ? { stamp } : {}), chunks: before.chunks };
      continue;
    }
    waiting.push({ index, entry, before, database, stamp });
  }
  let databaseTurn = Promise.resolve();
  const saveOne = async ({ index, entry, before, database, stamp }) => {
    const path = join(root, entry.path);
    let copy = null;
    try {
      if (database && scratch) {
        if (!(await roomForCopy(path, entry, scratch, freeBytes))) {
          if (before) slots[index] = before;
          unsaved.push(entry.path);
          return;
        }
        copy = await databaseCopy(path, scratch);
      }
      const chunks = await chunksOf(copy ?? path, store);
      slots[index] = { ...entry, ...(stamp ? { stamp } : {}), chunks };
      uploaded += 1;
    } catch (error) {
      if (before) slots[index] = before;
      if (error?.code !== "ENOENT") unsaved.push(entry.path);
    } finally {
      if (copy) await rm(copy, { force: true }).catch(() => {});
    }
  };
  const order = resumeOrder(waiting, resumeAfter);
  let next = 0;
  let started = 0;
  let lastStarted;
  const worker = async () => {
    while (next < order.length) {
      const item = order[next++];
      const late = now() > deadline;
      if (late && started > 0) {
        if (item.before) slots[item.index] = item.before;
        deferred += 1;
        continue;
      }
      started += 1;
      lastStarted = item.entry.path;
      if (item.database && scratch) {
        const turn = databaseTurn.then(() => saveOne(item));
        databaseTurn = turn.catch(() => {});
        await turn;
      } else {
        await saveOne(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, order.length)) }, worker));
  const entries = slots.filter(Boolean);
  const carryOn = deferred > 0 ? lastStarted : undefined;
  const manifest = { version: MANIFEST_VERSION, createdAt: now(), ...(app ? { app } : {}), entries };
  if (uploaded > 0 || !previous || (app && previous.app !== app) || previous.entries.length !== entries.length || changedShape(previous.entries, entries)) {
    await store.putManifest(manifest);
    return { manifest, written: true, uploaded, unsaved, deferred, resumeAfter: carryOn };
  }
  return { manifest: previous, written: false, uploaded, unsaved, deferred, resumeAfter: carryOn };
}

export function settleWithin(work, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), ms); });
  return Promise.race([work.then(() => "done", () => "failed"), late]).finally(() => clearTimeout(timer));
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
export const CHUNK_ATTEMPTS = 5;
export const CHUNK_RETRY_MS = 1_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeAll(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written);
    written += bytesWritten;
  }
  return position + written;
}

function waitUnlessStopped(ms, stop) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener("abort", done, { once: true });
  });
}

async function readChunk(store, hash, stop, { attempts, retryMs }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.get(hash, { signal: stop });
    } catch (error) {
      if (stop.aborted || attempt >= attempts) throw error;
      await waitUnlessStopped(attempt * retryMs, stop);
      if (stop.aborted) throw error;
    }
  }
}

async function alreadyRestored(path, entry) {
  const existing = await lstat(path).catch(() => null);
  return existing?.isFile() === true && existing.size === entry.size && Math.trunc(existing.mtimeMs) === Math.trunc(entry.mtimeMs);
}

async function download(entry, store, staging, stop, retries) {
  const handle = await open(staging, "wx", 0o600);
  try {
    let position = 0;
    for (const hash of entry.chunks) {
      if (stop.aborted) return false;
      const bytes = await readChunk(store, hash, stop, retries);
      if (sha256(bytes) !== hash) throw new Error(`corrupt chunk for ${entry.path}`);
      position = await writeAll(handle, bytes, position);
    }
  } finally {
    await handle.close();
  }
  return !stop.aborted;
}

async function clearForFile(path) {
  const existing = await lstat(path).catch(() => null);
  if (existing?.isDirectory()) await rm(path, { recursive: true, force: true });
}

export async function restore(root, store, owner, { chunkAttempts = CHUNK_ATTEMPTS, chunkRetryMs = CHUNK_RETRY_MS, finished = new Set() } = {}) {
  const retries = { attempts: chunkAttempts, retryMs: chunkRetryMs };
  const manifest = await store.manifest();
  if (!manifest) return { manifest: null, files: 0 };
  const kept = manifest.entries.filter((entry) => !transient(entry));
  let files = 0;
  const own = async (path) => {
    if (owner) await lchown(path, owner.uid, owner.gid);
  };
  for (const entry of kept) {
    if (entry.type !== "dir") continue;
    const path = join(root, entry.path);
    await mkdir(path, { recursive: true, mode: entry.mode });
    await own(path);
  }
  for (const entry of kept) {
    if (entry.type !== "link") continue;
    const path = join(root, entry.path);
    await rm(path, { force: true, recursive: true });
    await symlink(entry.target, path);
    await own(path);
  }
  const pending = kept.filter((entry) => entry.type !== "dir" && entry.type !== "link");
  const stopping = new AbortController();
  const failures = [];
  const writeOne = async (entry) => {
    const path = join(root, entry.path);
    if (finished.has(entry.path) && (await alreadyRestored(path, entry))) {
      files += 1;
      return;
    }
    const staging = join(dirname(path), `${RESTORING_PREFIX}${sha256(entry.path).slice(0, 24)}`);
    await rm(staging, { force: true, recursive: true });
    try {
      if (!(await download(entry, store, staging, stopping.signal, retries))) return;
      await chmod(staging, entry.mode);
      await own(staging);
      const moment = new Date(entry.mtimeMs);
      await utimes(staging, moment, moment);
      if (stopping.signal.aborted) return;
      await clearForFile(path);
      await rename(staging, path);
      finished.add(entry.path);
      files += 1;
    } finally {
      await rm(staging, { force: true });
    }
  };
  let next = 0;
  const worker = async () => {
    while (!stopping.signal.aborted && next < pending.length) {
      try {
        await writeOne(pending[next++]);
      } catch (error) {
        failures.push(error);
        stopping.abort(error);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(RESTORE_PARALLEL, pending.length) }, worker));
  if (failures.length > 0) throw failures[0];
  for (const entry of [...kept].reverse()) {
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

export async function keptRestorePoints(store) {
  const kept = [];
  for (const name of await store.restorePoints()) kept.push(await store.restorePoint(name));
  return kept;
}

export const CLEANUP_PARALLEL = 8;

export async function collectGarbageWithin(store, manifest, { pending = [], budgetMs = Infinity, now = Date.now, parallel = CLEANUP_PARALLEL } = {}) {
  if (!manifest) return { removed: 0, finished: true };
  const keep = referencedBlobs(manifest);
  for (const kept of [...pending, ...(await keptRestorePoints(store))]) for (const hash of referencedBlobs(kept)) keep.add(hash);
  const unused = [];
  let cursor;
  do {
    const page = await store.listBlobs(cursor);
    for (const hash of page.hashes) if (!keep.has(hash)) unused.push(hash);
    cursor = page.cursor;
  } while (cursor);
  const deadline = now() + budgetMs;
  let removed = 0;
  while (removed < unused.length && (removed === 0 || now() < deadline)) {
    const batch = unused.slice(removed, removed + parallel);
    await Promise.all(batch.map((hash) => store.deleteBlob(hash)));
    removed += batch.length;
  }
  return { removed, finished: removed === unused.length };
}

export async function collectGarbage(store, manifest, { pending = [] } = {}) {
  return (await collectGarbageWithin(store, manifest, { pending })).removed;
}
