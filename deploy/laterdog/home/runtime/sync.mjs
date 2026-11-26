import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lchown, link, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, statfs, symlink, utimes } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MANIFEST_VERSION = 1;
export const BLOB_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 120_000;
export const FINAL_SAVE_MS = 120_000;
export const SNAPSHOT_RESERVE_BYTES = 256 * 1024 * 1024;
export const MEMORY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;
export const WHOLE_DATABASE_PAGES = 2_147_483_647;
const COPY_NAME = /^[a-f0-9]{64}\.sqlite(?:-journal)?$/;
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

export function skipped(name, type = "file") {
  return SKIPPED_NAMES.has(name) || REFRESH_LOCK_NAMES.has(name) || name.startsWith(RESTORING_PREFIX) || (type !== "dir" && SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix)));
}

export function skippedPath(path) {
  return SKIPPED_PATHS.some((skippedRoot) => path === skippedRoot || path.startsWith(`${skippedRoot}/`));
}

export function heldLock(name, type) {
  return type === "dir" && name.endsWith(LOCK_DIRECTORY_SUFFIX);
}

export function transient(entry) {
  const names = entry.path.split("/");
  return (
    skippedPath(entry.path) ||
    names.some((name, index) => {
      const type = index < names.length - 1 ? "dir" : entry.type;
      return skipped(name, type) || heldLock(name, type);
    })
  );
}

const NAMED_FAILURES = new Set(["TimeoutError", "AbortError"]);

export function failureReason(error) {
  const code = error?.cause?.code ?? (typeof error?.code === "string" ? error.code : undefined);
  return String(code ?? (NAMED_FAILURES.has(error?.name) ? error.name : undefined) ?? error?.message ?? error).slice(0, 120);
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
    async verifyPreviousBackup(descriptor) {
      const response = await call("work-folders/verify-previous-backup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor)
      });
      if (!response.ok || (await response.json()).verified !== true) throw new Error("The retained previous backup could not be independently verified.");
    },
    async legacyManifest(hash) {
      if (!HASH.test(hash)) throw new Error("Invalid pinned home snapshot.");
      const response = await call("work-folders/legacy-manifests/" + hash);
      if (!response.ok) throw new Error("The pinned home snapshot is unavailable.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Pinned home snapshot checksum mismatch.");
      return parseManifest(JSON.parse(bytes.toString("utf8")));
    },
    async workFolderPlacement() {
      const response = await call("work-folders/placement");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`work folder placement read failed: ${response.status}`);
      return response.json();
    },
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

export const LISTING_PARALLEL = 32;

async function inspected(path, inspect) {
  try {
    const info = await inspect(path);
    return info.isSymbolicLink() ? { info, target: await readlink(path) } : { info };
  } catch {
    return null;
  }
}

async function inspectedTogether(paths, inspect) {
  const all = [];
  for (let start = 0; start < paths.length; start += LISTING_PARALLEL) {
    all.push(...(await Promise.all(paths.slice(start, start + LISTING_PARALLEL).map((path) => inspected(path, inspect)))));
  }
  return all;
}

async function walk(root, directory, found, inspect, { exclude, exactScope, links }) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (exactScope?.(relative(root, directory))) throw error;
    return;
  }
  const kept = names.sort().filter(name => {
    const path = relative(root, join(directory, name));
    return !exclude?.(path) && (exactScope?.(path) || !skipped(name, "dir") && !skippedPath(path));
  });
  const listed = await inspectedTogether(kept.map((name) => join(directory, name)), inspect);
  for (const [index, name] of kept.entries()) {
    const path = join(directory, name);
    const scope = exactScope?.(relative(root, path));
    if (!listed[index]) {
      if (scope) throw new Error("Unable to verify a rolled back working folder entry");
      continue;
    }
    const { info, target } = listed[index];
    if (!scope && !info.isDirectory() && skipped(name)) continue;
    const entry = { path: relative(root, path), mode: info.mode & 0o7777, mtimeMs: Math.floor(info.mtimeMs) };
    if (info.isDirectory()) {
      if (!scope && heldLock(name, "dir")) continue;
      found.push({ ...entry, type: "dir" });
      await walk(root, path, found, inspect, { exclude, exactScope, links });
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target });
    } else if (info.isFile()) {
      if (scope && info.nlink > 1) {
        const key = JSON.stringify([scope, info.dev, info.ino]);
        const other = links.get(key);
        if (other) entry.hardlink = other;
        else links.set(key, entry.path);
      }
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export async function scan(root, { inspect = lstat, exclude, exactScope } = {}) {
  const found = [];
  await walk(root, root, found, inspect, { exclude, exactScope, links: new Map() });
  return found;
}

async function filled(handle, buffer, from) {
  let length = from;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length;
}

export function storedPieces(store, alreadyStored = []) {
  const stored = new Set(alreadyStored);
  const storing = new Map();
  return async (hash, bytes) => {
    if (stored.has(hash)) return;
    if (!storing.has(hash)) {
      const work = (async () => {
        if (!(await store.has(hash))) await store.put(hash, bytes);
        stored.add(hash);
      })().finally(() => storing.delete(hash));
      storing.set(hash, work);
    }
    await storing.get(hash);
  };
}

export async function chunksOf(path, store, { opened = open, keep = storedPieces(store) } = {}) {
  const handle = await opened(path, "r");
  const chunks = [];
  try {
    const { size } = await handle.stat();
    let buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size + 1));
    for (;;) {
      let length = await filled(handle, buffer, 0);
      if (length === buffer.length && length < CHUNK_BYTES) {
        const whole = Buffer.allocUnsafe(CHUNK_BYTES);
        buffer.copy(whole);
        buffer = whole;
        length = await filled(handle, buffer, length);
      }
      if (length === 0) break;
      const bytes = buffer.subarray(0, length);
      const hash = createHash("sha256").update(bytes).digest("hex");
      await keep(hash, Buffer.from(bytes));
      chunks.push(hash);
      if (length < CHUNK_BYTES) break;
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

async function logBytes(path) {
  const wal = await lstat(`${path}-wal`).catch((error) => (error?.code === "ENOENT" ? { size: 0 } : null));
  return wal ? wal.size : null;
}

async function measured(read) {
  const value = await Promise.resolve().then(read).catch(() => null);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function memoryAvailable() {
  const info = await readFile("/proc/meminfo", "utf8").catch(() => null);
  const kilobytes = info ? Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]) : Number.NaN;
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : process.availableMemory();
}

async function usableFolder(folder) {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (((await stat(folder)).mode & 0o222) === 0) return false;
    await access(folder, constants.W_OK | constants.X_OK);
    for (const name of await readdir(folder)) if (COPY_NAME.test(name)) await rm(join(folder, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function copyPlaces({ scratch, memoryScratch, freeBytes, availableMemory, memoryMarginBytes }) {
  let memoryFolder;
  const memoryReady = () => (memoryFolder ??= usableFolder(memoryScratch));
  const inMemory = async (bytes) => {
    if (!memoryScratch) return false;
    const available = await measured(availableMemory);
    if (available === null || available - bytes < memoryMarginBytes) return false;
    if (!(await memoryReady())) return false;
    const free = await measured(() => freeBytes(memoryScratch));
    return free !== null && free >= bytes;
  };
  const onDisk = async (bytes) => {
    const free = await measured(() => freeBytes(scratch));
    return free !== null && free >= bytes + SNAPSHOT_RESERVE_BYTES;
  };
  return async (path, entry) => {
    const wal = await logBytes(path);
    if (wal === null) return [];
    const bytes = entry.size + wal;
    if (await inMemory(bytes)) return [{ place: "memory", folder: memoryScratch, bytes }, { place: "disk", folder: scratch, bytes, check: onDisk }];
    return (await onDisk(bytes)) ? [{ place: "disk", folder: scratch, bytes }] : [];
  };
}

async function databaseCopy(path, scratch) {
  const copy = join(scratch, `${createHash("sha256").update(path).digest("hex")}.sqlite`);
  await rm(copy, { force: true });
  const source = new DatabaseSync(path);
  try {
    await backup(source, copy, { rate: WHOLE_DATABASE_PAGES });
  } catch (error) {
    await rm(copy, { force: true }).catch(() => {});
    throw error;
  } finally {
    source.close();
  }
  return copy;
}

async function copiedSomewhere(path, places, onCopy, entryPath) {
  let failure = null;
  for (const target of places) {
    if (target.check && !(await target.check(target.bytes))) break;
    onCopy?.({ path: entryPath, place: target.place, bytes: target.bytes });
    try {
      return { copy: await databaseCopy(path, target.folder), place: target.place };
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  return null;
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

export async function snapshot(root, store, previous, { scratch, memoryScratch, now = Date.now, clock = () => performance.now(), app, budgetMs = Infinity, freeBytes = diskFree, availableMemory = memoryAvailable, memoryMarginBytes = MEMORY_MARGIN_BYTES, onCopy, resumeAfter, parallel = SAVE_PARALLEL, exclude, exactScope } = {}) {
  const known = new Map((previous?.entries ?? []).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const unsaved = [];
  let unsavedReason;
  const keep = storedPieces(store, referencedBlobs(previous));
  const cannotSave = (path, reason) => {
    if (unsaved.length === 0) unsavedReason = reason;
    unsaved.push(path);
  };
  let uploaded = 0;
  let deferred = 0;
  const deadline = now() + budgetMs;
  if (scratch) await mkdir(scratch, { recursive: true, mode: 0o700 });
  if (scratch) await usableFolder(scratch);
  const placesFor = copyPlaces({ scratch, memoryScratch, freeBytes, availableMemory, memoryMarginBytes });
  const copies = [];
  let heldOnDiskBytes = 0;
  let heldInMemoryBytes = 0;
  const scanned = await scan(root, { exclude, exactScope });
  const slots = Array.from({ length: scanned.length }, () => null);
  const waiting = [];
  for (const [index, entry] of scanned.entries()) {
    if (entry.type !== "file") {
      slots[index] = entry;
      continue;
    }
    const before = known.get(entry.path);
    const database = !exactScope?.(entry.path) && SQLITE.test(entry.path);
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
      let timing;
      if (database && scratch) {
        const places = await placesFor(path, entry);
        if (places.length === 0) {
          if (before) slots[index] = before;
          cannotSave(entry.path, "no room for a copy");
          return;
        }
        const copyStarted = clock();
        const copied = await copiedSomewhere(path, places, onCopy, entry.path);
        if (!copied) {
          if (before) slots[index] = before;
          cannotSave(entry.path, "no room for a copy");
          return;
        }
        copy = copied.copy;
        const bytes = (await stat(copy)).size;
        if (copied.place === "disk") heldOnDiskBytes = Math.max(heldOnDiskBytes, bytes);
        else heldInMemoryBytes = Math.max(heldInMemoryBytes, bytes);
        timing = { path: entry.path, place: copied.place, bytes, copyMs: Math.round(clock() - copyStarted) };
      }
      const hashStarted = clock();
      const chunks = await chunksOf(copy ?? path, store, { keep });
      if (timing) copies.push({ ...timing, hashMs: Math.round(clock() - hashStarted) });
      slots[index] = { ...entry, ...(stamp ? { stamp } : {}), chunks };
      uploaded += 1;
    } catch (error) {
      if (before) slots[index] = before;
      if (error?.code !== "ENOENT") cannotSave(entry.path, failureReason(error));
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
    return { manifest, written: true, uploaded, unsaved, unsavedReason, deferred, resumeAfter: carryOn, copies, heldOnDiskBytes, heldInMemoryBytes };
  }
  return { manifest: previous, written: false, uploaded, unsaved, unsavedReason, deferred, resumeAfter: carryOn, copies, heldOnDiskBytes, heldInMemoryBytes };
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
    if (left.path !== right.path || left.type !== right.type || left.mode !== right.mode || left.target !== right.target || left.hardlink !== right.hardlink) return true;
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
      const bytes = await store.get(hash, { signal: stop });
      if (sha256(bytes) !== hash) throw new Error(`a piece arrived damaged (${bytes.length} bytes)`);
      return bytes;
    } catch (error) {
      if (stop.aborted || attempt >= attempts) throw error;
      await waitUnlessStopped(attempt * retryMs, stop);
      if (stop.aborted) throw error;
    }
  }
}

async function alreadyRestored(path, entry) {
  const existing = await lstat(path).catch(() => null);
  return existing?.isFile() === true && existing.size === entry.size && Math.round(existing.mtimeMs) === Math.trunc(entry.mtimeMs);
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

export async function restore(root, store, owner, { chunkAttempts = CHUNK_ATTEMPTS, chunkRetryMs = CHUNK_RETRY_MS, finished = new Set(), exclude, exactScope } = {}) {
  const retries = { attempts: chunkAttempts, retryMs: chunkRetryMs };
  const manifest = await store.manifest();
  if (!manifest) return { manifest: null, files: 0 };
  const kept = manifest.entries.filter(entry => !exclude?.(entry.path) && (exactScope?.(entry.path) || !transient(entry)));
  const hardLinks = kept.filter(entry => entry.hardlink !== undefined);
  const byPath = new Map(kept.map(entry => [entry.path, entry]));
  for (const entry of hardLinks) {
    const original = byPath.get(entry.hardlink);
    if (!exactScope?.(entry.path) || exactScope(entry.path) !== exactScope(entry.hardlink) ||
        !original || original.type !== "file" || entry.type !== "file" || original.hardlink !== undefined ||
        original.mode !== entry.mode || original.mtimeMs !== entry.mtimeMs || original.size !== entry.size ||
        JSON.stringify(original.chunks) !== JSON.stringify(entry.chunks)) throw new Error("Invalid working folder hard link");
    for (const name of [entry.path, original.path]) {
      const fields = name.split("/");
      if (fields.some(part => !part || part === "." || part === "..")) throw new Error("Invalid working folder hard link path");
      for (let i = 1; i < fields.length; i++) {
        if (byPath.get(fields.slice(0, i).join("/"))?.type !== "dir") throw new Error("Invalid hard link parent");
      }
    }
  }
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
  const pending = kept.filter(entry => entry.type === "file" && entry.hardlink === undefined);
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
  for (const entry of hardLinks) {
    const path = join(root, entry.path), original = join(root, entry.hardlink);
    const info = await lstat(original);
    if (!info.isFile() || info.size !== entry.size) throw new Error("Working folder hard link target changed");
    const temporary = join(dirname(path), RESTORING_PREFIX + sha256(entry.path).slice(0, 24));
    await rm(temporary, { force: true });
    try {
      await link(original, temporary);
      await clearForFile(path);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    files++;
  }
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
