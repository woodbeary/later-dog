import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { chmod, lchown, link, lstat, mkdir, open, rm, unlink, utimes } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { CHUNK_BYTES } from "./sync.mjs";

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_ROOTS = [".claude/projects/", ".laterdog/events/", ".laterdog/native/", ".laterdog/tool-results/", ".laterdog/checkpoints/"];
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_PATHS = 2000;
export const MAX_NEEDLES = 50;
const RESTORING_PREFIX = ".laterdog-restoring-";
const HASH = /^[a-f0-9]{64}$/;
const NEEDLE = /^[A-Za-z0-9_.-]{8,200}$/;

export function archivable(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0")) return false;
  if (normalize(path) !== path) return false;
  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "" || part.startsWith(RESTORING_PREFIX))) return false;
  if (parts.some((part) => /^(?:auth|credentials|secrets|tokens?)(?:[.-]|$)/i.test(part))) return false;
  return ARCHIVE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length);
}

export function parseIndex(input) {
  if (input === null || input === undefined) return { version: ARCHIVE_VERSION, entries: {} };
  if (input.version !== ARCHIVE_VERSION || !input.entries || typeof input.entries !== "object" || Array.isArray(input.entries)) throw new Error("unreadable archive index");
  for (const [path, entry] of Object.entries(input.entries)) {
    if (!archivable(path)) throw new Error("unsafe archive path");
    if (!Array.isArray(entry?.chunks) || !entry.chunks.every((hash) => HASH.test(hash)) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.mtimeMs)) {
      throw new Error("bad archive entry");
    }
  }
  return input;
}

export function referencedArchiveBlobs(index) {
  const keep = new Set();
  for (const entry of Object.values(index?.entries ?? {})) for (const hash of entry.chunks) keep.add(hash);
  return keep;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function same(info, stamp) {
  return Boolean(info?.isFile()) && info.size === stamp.size && info.mtimeMs === stamp.mtimeMs
    && info.ctimeMs === stamp.ctimeMs && info.ino === stamp.ino && info.dev === stamp.dev;
}

function sameChunks(left, right) {
  return left.length === right.length && left.every((hash, at) => hash === right[at]);
}

async function eachChunk(path, visit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      await visit(Buffer.from(buffer.subarray(0, bytesRead)));
      if (bytesRead < CHUNK_BYTES) break;
    }
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written);
    written += bytesWritten;
  }
  return position + written;
}

export function createArchiver({ root, store, owner = null, log = () => {}, now = Date.now, canRemove = async () => true }) {
  let index = null;
  let queue = Promise.resolve();
  const counts = { archivedFiles: 0, archivedBytes: 0, restoredFiles: 0, restoredBytes: 0, failedFiles: 0 };

  const serial = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async () => {
    if (!index) index = parseIndex(await store.archiveIndex());
    return index;
  };

  const own = async (path) => {
    if (owner) await lchown(path, owner.uid, owner.gid);
  };

  const safeParents = async (path, make = false) => {
    let at = root;
    for (const part of path.split("/").slice(0, -1)) {
      at = join(at, part);
      if (make) {
        try { await mkdir(at, { mode: 0o700 }); await own(at); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const info = await lstat(at);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe archive parent");
    }
  };

  const copyOut = async (path) => {
    await safeParents(path);
    const full = join(root, path);
    const before = await lstat(full).catch(() => null);
    if (!before?.isFile()) return { path, skipped: "missing" };
    const stamp = { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, ino: before.ino, dev: before.dev };
    const chunks = [];
    await eachChunk(full, async (bytes) => {
      const hash = sha256(bytes);
      if (!(await store.hasArchived(hash))) await store.putArchived(hash, bytes);
      const back = await store.getArchived(hash);
      if (sha256(back) !== hash) throw new Error(`the archived copy of ${path} did not read back intact`);
      chunks.push(hash);
    });
    const after = await lstat(full).catch(() => null);
    if (!same(after, stamp)) return { path, skipped: "changed" };
    return { path, entry: { ...stamp, mode: before.mode & 0o777, chunks, archivedAt: now() } };
  };

  const archive = (paths) => serial(async () => {
    const current = await load();
    const results = [];
    const ready = [];
    for (const path of paths) {
      if (!archivable(path)) {
        results.push({ path, skipped: "refused" });
        continue;
      }
      try {
        const copied = await copyOut(path);
        if (copied.entry) ready.push(copied);
        else results.push(copied);
      } catch (error) {
        counts.failedFiles += 1;
        log(`could not archive ${path}: ${error.message}`);
        results.push({ path, skipped: "failed" });
      }
    }
    if (ready.length) {
      const next = { version: ARCHIVE_VERSION, entries: { ...current.entries } };
      for (const { path, entry } of ready) {
        const prior = current.entries[path];
        const { history = [], ...version } = prior ?? {};
        next.entries[path] = prior ? { ...entry, history: [...history, version] } : entry;
      }
      await store.putArchiveIndex(next);
      const saved = parseIndex(await store.archiveIndex());
      index = next;
      for (const { path, entry } of ready) {
        const kept = saved.entries[path];
        if (!kept || kept.size !== entry.size || !sameChunks(kept.chunks, entry.chunks)) {
          results.push({ path, skipped: "unverified" });
          continue;
        }
        await safeParents(path);
        const full = join(root, path);
        if (!same(await lstat(full).catch(() => null), entry)) {
          results.push({ path, skipped: "changed" });
          continue;
        }
        if (!await canRemove(full, entry)) {
          results.push({ path, skipped: "open-or-unknown" });
          continue;
        }
        if (!same(await lstat(full).catch(() => null), entry)) {
          results.push({ path, skipped: "changed" });
          continue;
        }
        try {
          await unlink(full);
        } catch {
          results.push({ path, skipped: "kept" });
          continue;
        }
        counts.archivedFiles += 1;
        counts.archivedBytes += entry.size;
        results.push({ path, archived: entry.size });
      }
    }
    const archived = results.filter((result) => result.archived !== undefined);
    return {
      archived: archived.length,
      bytes: archived.reduce((sum, result) => sum + result.archived, 0),
      paths: archived.map((result) => result.path),
      skipped: results.filter((result) => result.skipped).map(({ path, skipped }) => ({ path, why: skipped })),
    };
  });

  const bringBack = async (path, entry) => {
    await safeParents(path, true);
    const full = join(root, path);
    const parent = dirname(full);
    const made = await mkdir(parent, { recursive: true, mode: 0o700 });
    if (made) {
      const segments = relative(made, parent).split("/").filter(Boolean);
      let at = made;
      await own(at);
      for (const segment of segments) {
        at = join(at, segment);
        await own(at);
      }
    }
    const staging = join(parent, `${RESTORING_PREFIX}${randomUUID()}`);
    let staged = false;
    try {
      const handle = await open(staging, "wx", 0o600);
      staged = true;
      let position = 0;
      try {
        for (const hash of entry.chunks) {
          const bytes = await store.getArchived(hash);
          if (sha256(bytes) !== hash) throw new Error(`corrupt archived chunk for ${path}`);
          position = await writeAll(handle, bytes, position);
        }
      } finally {
        await handle.close();
      }
      if (position !== entry.size) throw new Error(`archived copy of ${path} has the wrong size`);
      await chmod(staging, entry.mode ?? 0o600);
      await own(staging);
      const moment = new Date(entry.mtimeMs);
      await utimes(staging, moment, moment);
      await link(staging, full);
    } finally {
      if (staged) await rm(staging, { force: true });
    }
  };

  const restore = (needles, exactPaths = null) => serial(async () => {
    const wanted = needles.filter((needle) => typeof needle === "string" && NEEDLE.test(needle));
    const current = await load();
    const matches = Object.entries(current.entries).filter(([path]) => exactPaths ? exactPaths.includes(path) : wanted.some((needle) => path.includes(needle)));
    let restored = 0;
    let bytes = 0;
    let failed = 0;
    if (!matches.length) return { restored, bytes, failed, paths: [] };
    const next = { version: ARCHIVE_VERSION, entries: { ...current.entries } };
    const paths = [];
    for (const [path, entry] of matches) {
      try {
        const existing = await lstat(join(root, path)).catch(() => null);
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("unsafe restore target");
        if (!existing) {
          await bringBack(path, entry);
          restored += 1;
          bytes += entry.size;
          paths.push(path);
        }
        next.entries[path] = { ...entry, restoredAt: now() };
      } catch (error) {
        failed += 1;
        log(`could not restore ${path}: ${error.message}`);
      }
    }
    index = next;
    counts.restoredFiles += restored;
    counts.restoredBytes += bytes;
    try {
      await store.putArchiveIndex(next);
    } catch (error) {
      log(`could not record restored files: ${error.message}`);
    }
    return { restored, bytes, failed, paths };
  });


  const status = () => serial(async () => {
    const current = await load();
    let files = 0;
    let bytes = 0;
    const paths = [];
    for (const [path, entry] of Object.entries(current.entries)) {
      if (entry.restoredAt) continue;
      files += 1;
      bytes += entry.size;
      paths.push(path);
    }
    return { files, bytes, paths, ...counts };
  });

  return { archive, restore, status };
}

function authorized(request, token) {
  const presented = Buffer.from(/^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function body(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("not JSON"), { status: 400 });
  }
}

function strings(value, limit) {
  if (!Array.isArray(value) || value.length > limit || !value.every((item) => typeof item === "string")) throw Object.assign(new Error("bad list"), { status: 400 });
  return value;
}

export function archiveHandler(archiver, token) {
  return async (request, response) => {
    const reply = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    try {
      if (!token || !authorized(request, token)) return reply(401, { error: "unauthorized" });
      const path = new URL(request.url ?? "/", "http://archive").pathname;
      if (request.method === "GET" && path === "/status") return reply(200, await archiver.status());
      if (request.method === "POST" && path === "/archive") return reply(200, await archiver.archive(strings((await body(request)).paths, MAX_PATHS)));
      if (request.method === "POST" && path === "/restore-logs") {
        const paths = strings((await body(request)).paths, MAX_PATHS);
        if (!paths.every(value => [".laterdog/events/", ".laterdog/native/"].some(root => value.startsWith(root) && /^[A-Za-z0-9_-]{8,200}[.]ndjson$/.test(value.slice(root.length))))) return reply(400, { error: "only exact thread logs" });
        return reply(200, await archiver.restore([], paths));
      }
      if (request.method === "POST" && path === "/restore") return reply(200, await archiver.restore(strings((await body(request)).contains, MAX_NEEDLES)));
      return reply(404, { error: "not found" });
    } catch (error) {
      return reply(error.status ?? 500, { error: error.message });
    }
  };
}

export function serveArchive(archiver, { token, host = "127.0.0.1", port = 0 }) {
  const server = createServer(archiveHandler(archiver, token));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ url: `http://${host}:${address.port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
