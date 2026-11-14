import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, chmod, lchown, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, statfs, symlink, utimes, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { CHUNK_BYTES, heldLock, skipped } from "./sync.mjs";

export const MARKER = ".laterdog-away.json";
export const RECORD_VERSION = 1;
export const RECORD_MAX_BYTES = 11 * 1024 * 1024;
export const LOW_BYTES = 2 * 1024 * 1024 * 1024;
export const FOLDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const RELEASED_FILE = "released.ndjson";
export const LISTED_LEFT_OUT = 200;
export const BRING_ALL_BACK = "POST /api/storage/folders/bring-back on this home, signed in as its owner (see docs/laterdog/folders-away.md)";
const PREFIX = ".laterdog-restoring-";
const HASH = /^[a-f0-9]{64}$/;
const PIECE_ATTEMPTS = 5;
const NOTE = "This chat's files were moved to this home's Cloud storage because nobody had used the chat for a while. Nothing was deleted. "
  + "They come back by themselves, whole, the next time this chat gets a message or its files are opened in the app.";

export class FolderChanged extends Error {}

export function pushedServerRefusal({ away, bringsBack, hash }) {
  if (!away || bringsBack) return null;
  return `the pushed server ${hash.slice(0, 12)} cannot bring back chats' files, and ${away} chat(s) have their files in Cloud storage; using this image's server. To bring every folder back first: ${BRING_ALL_BACK}`;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createExclusive() {
  let tail = Promise.resolve();
  return {
    run(work) {
      const next = tail.then(work, work);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export function safeEntryPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0") || normalize(path) !== path) return false;
  return path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith(PREFIX));
}

function typeOf(info) {
  return info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : info.isFile() ? "file" : "other";
}

function leftOutByTheSave(name, type) {
  return type === "other" || (type === "dir" ? skipped(name, "dir") || heldLock(name, "dir") : skipped(name, type));
}

async function sizeOf(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.blocks * 512;
  let total = info.blocks * 512;
  for (const name of await readdir(path).catch(() => [])) total += await sizeOf(join(path, name));
  return total;
}

export async function listFolder(root) {
  const entries = [];
  const leftOut = { count: 0, bytes: 0, paths: [] };
  const walk = async (at, prefix) => {
    for (const name of (await readdir(at)).sort()) {
      const full = join(at, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(full);
      const type = typeOf(info);
      if (leftOutByTheSave(name, type)) {
        leftOut.count += 1;
        leftOut.bytes += await sizeOf(full);
        if (leftOut.paths.length < LISTED_LEFT_OUT) leftOut.paths.push(path);
        continue;
      }
      const base = { path, type, mode: info.mode & 0o7777, mtimeMs: info.mtimeMs };
      if (type === "dir") {
        entries.push(base);
        await walk(full, path);
      } else if (type === "link") {
        entries.push({ ...base, target: await readlink(full) });
      } else {
        entries.push({ ...base, size: info.size, ino: info.ino, ctimeMs: info.ctimeMs });
      }
    }
  };
  await walk(root, "");
  return { entries, leftOut };
}

function stampKey(entry) {
  return entry.type === "file"
    ? `${entry.path}|file|${entry.mode}|${entry.mtimeMs}|${entry.size}|${entry.ino}|${entry.ctimeMs}`
    : entry.type === "link" ? `${entry.path}|link|${entry.target}` : `${entry.path}|dir|${entry.mode}`;
}

export function sameFolder(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, at) => stampKey(entry) === stampKey(right[at]));
}

export function parseRecord(bytes, hash) {
  if (sha256(bytes) !== hash) throw new Error("the stored record does not match its checksum");
  const record = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (record?.version !== RECORD_VERSION || record.kind !== "chat-folder" || !FOLDER_ID.test(record.botId) || !FOLDER_ID.test(record.threadId)) throw new Error("unreadable record");
  if (!Array.isArray(record.entries) || !Array.isArray(record.pieces) || !record.pieces.every((piece) => HASH.test(piece)) || !HASH.test(record.streamSha256)) throw new Error("unreadable record");
  let bytesTotal = 0;
  for (const entry of record.entries) {
    if (!safeEntryPath(entry.path) || !["dir", "file", "link"].includes(entry.type) || !Number.isInteger(entry.mode) || !Number.isFinite(entry.mtimeMs)) throw new Error("unsafe record entry");
    if (entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH.test(entry.sha256))) throw new Error("bad record file");
    if (entry.type === "link" && typeof entry.target !== "string") throw new Error("bad record link");
    if (entry.type === "file") bytesTotal += entry.size;
  }
  if (bytesTotal !== record.bytes) throw new Error("the record's sizes do not add up");
  return record;
}

export function parseMarker(text) {
  const marker = JSON.parse(text);
  if (marker?.version !== RECORD_VERSION || !FOLDER_ID.test(marker.botId) || !FOLDER_ID.test(marker.threadId) || !HASH.test(marker.record) || !Number.isSafeInteger(marker.bytes)) throw new Error("unreadable marker");
  return marker;
}

export function createFolderAway({ tasksDir, ledgerDir, store, owner = null, log = () => {}, now = Date.now, lock = createExclusive(), freeBytes, lowBytes = LOW_BYTES, pieceBytes = CHUNK_BYTES, recordMaxBytes = RECORD_MAX_BYTES, retryMs = 500 }) {
  const pending = new Map();
  const free = freeBytes ?? (async () => { const disk = await statfs(tasksDir); return disk.bavail * disk.bsize; });
  const own = async (path) => { if (owner) await lchown(path, owner.uid, owner.gid); };

  const folderOf = (botId, threadId) => {
    if (!FOLDER_ID.test(botId) || !FOLDER_ID.test(threadId)) throw new Error("not a chat folder");
    return { botDir: join(tasksDir, botId), dir: join(tasksDir, botId, threadId) };
  };

  const realDirectory = async (path) => {
    const info = await lstat(path).catch(() => null);
    return Boolean(info?.isDirectory() && !info.isSymbolicLink());
  };

  const readMarker = async (dir) => {
    if (!await realDirectory(dir)) return null;
    const names = await readdir(dir);
    if (!names.includes(MARKER)) return null;
    const text = await readFile(join(dir, MARKER), "utf8");
    return { text, marker: parseMarker(text), alone: names.length === 1 };
  };

  const getPiece = async (hash) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const bytes = await store.getArchived(hash);
        if (sha256(bytes) !== hash) throw new Error(`a stored piece ${hash.slice(0, 12)} is damaged`);
        return bytes;
      } catch (error) {
        if (attempt >= PIECE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * retryMs));
      }
    }
  };

  const storeVerified = async (bytes) => {
    const hash = sha256(bytes);
    if (!(await store.hasArchived(hash))) await store.putArchived(hash, bytes);
    const back = await store.getArchived(hash);
    if (sha256(back) !== hash) throw new Error("a stored piece did not read back intact");
    return hash;
  };

  const pack = async (botId, threadId) => {
    const { dir } = folderOf(botId, threadId);
    if (!await realDirectory(join(tasksDir, botId)) || !await realDirectory(dir)) throw new Error("that chat has no folder");
    if (await readMarker(dir).catch(() => null)) throw new Error("that chat's files are already away");
    const { entries, leftOut } = await listFolder(dir);
    const pieces = [];
    const stream = createHash("sha256");
    let buffer = Buffer.alloc(pieceBytes);
    let filled = 0;
    const flush = async () => {
      if (!filled) return;
      pieces.push(await storeVerified(Buffer.from(buffer.subarray(0, filled))));
      buffer = Buffer.alloc(pieceBytes);
      filled = 0;
    };
    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const full = join(dir, entry.path);
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash("sha256");
      let read = 0;
      try {
        const opened = await handle.stat();
        if (opened.ino !== entry.ino || opened.size !== entry.size) throw new FolderChanged(`${entry.path} changed while it was copied`);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, filled, pieceBytes - filled, null);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(filled, filled + bytesRead));
          stream.update(buffer.subarray(filled, filled + bytesRead));
          filled += bytesRead;
          read += bytesRead;
          if (filled === pieceBytes) await flush();
        }
      } finally {
        await handle.close();
      }
      const after = await lstat(full).catch(() => null);
      if (read !== entry.size || !after || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs || after.ino !== entry.ino) {
        throw new FolderChanged(`${entry.path} changed while it was copied`);
      }
      entry.sha256 = hash.digest("hex");
      bytes += entry.size;
      files += 1;
    }
    await flush();
    const record = { version: RECORD_VERSION, kind: "chat-folder", botId, threadId, packedAt: now(), files, bytes, entries, leftOut, pieces, streamSha256: stream.digest("hex") };
    const recordBytes = Buffer.from(JSON.stringify(record));
    if (recordBytes.length > recordMaxBytes) throw new Error(`that chat has too many files to move (${files})`);
    const recordHash = await storeVerified(recordBytes);
    for (const piece of pieces) if (!(await store.hasArchived(piece))) throw new Error("a stored piece went missing before the move");
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    pending.set(id, { botId, threadId, record, recordHash });
    return { id, record: recordHash, files, bytes, pieces: pieces.length, leftOut: { count: leftOut.count, bytes: leftOut.bytes } };
  };

  const loosen = async (path) => {
    await chmod(path, 0o700).catch(() => undefined);
    if (await lstat(join(path, MARKER)).catch(() => null)) await chmod(join(path, MARKER), 0o600).catch(() => undefined);
  };

  const removeTree = async (path) => {
    await loosen(path);
    await rm(path, { recursive: true, force: true });
  };

  const swap = async (id) => {
    const job = pending.get(id);
    if (!job) throw new Error("nothing packed under that id");
    pending.delete(id);
    const { botDir, dir } = folderOf(job.botId, job.threadId);
    const stub = join(botDir, `${PREFIX}stub.${id}.${job.threadId}`);
    const away = join(botDir, `${PREFIX}away.${id}.${job.threadId}`);
    const marker = {
      version: RECORD_VERSION, what: "this chat's folder", botId: job.botId, threadId: job.threadId,
      movedAt: new Date(now()).toISOString(), where: "this home's Cloud storage", record: job.recordHash,
      files: job.record.files, bytes: job.record.bytes, streamSha256: job.record.streamSha256, note: NOTE,
    };
    await mkdir(stub, { mode: 0o700 });
    await writeFile(join(stub, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const written = parseMarker(await readFile(join(stub, MARKER), "utf8"));
    if (written.record !== job.recordHash) throw new Error("the marker did not write correctly");
    await chmod(join(stub, MARKER), 0o444);
    await chmod(stub, 0o755);
    let outcome;
    try {
      outcome = await lock.run(async () => {
        await rename(dir, away);
        let same = false;
        try { same = sameFolder(job.record.entries, (await listFolder(away)).entries); } catch {}
        if (!same) {
          await rename(away, dir);
          return { kept: "changed" };
        }
        try {
          await rename(stub, dir);
        } catch (error) {
          await rename(away, dir);
          throw error;
        }
        return { moved: true };
      });
    } finally {
      if (!outcome?.moved) await removeTree(stub).catch(() => undefined);
    }
    if (!outcome.moved) {
      log(`kept chat ${job.threadId}'s files where they are: something changed in them while they were being moved`);
      return outcome;
    }
    const freed = await sizeOf(away);
    log(`moved chat ${job.threadId}'s files (${job.record.files} files, ${Math.round(job.record.bytes / 1024 / 1024)} MB) to Cloud storage`);
    await removeTree(away).catch((error) => log(`could not finish clearing chat ${job.threadId}'s old copy: ${error.message}`));
    return { moved: true, files: job.record.files, bytes: job.record.bytes, freed };
  };

  const move = async (botId, threadId) => {
    const packed = await pack(botId, threadId);
    return { ...packed, ...(await swap(packed.id)) };
  };

  const build = async (staging, record) => {
    let piece = 0;
    let current = Buffer.alloc(0);
    let offset = 0;
    const stream = createHash("sha256");
    const take = async (size, visit) => {
      let left = size;
      while (left > 0) {
        if (offset === current.length) {
          if (piece >= record.pieces.length) throw new Error("the stored pieces end too early");
          current = Buffer.from(await getPiece(record.pieces[piece++]));
          offset = 0;
        }
        const slice = current.subarray(offset, offset + Math.min(left, current.length - offset));
        offset += slice.length;
        left -= slice.length;
        stream.update(slice);
        await visit(slice);
      }
    };
    for (const entry of record.entries) {
      const full = join(staging, entry.path);
      if (entry.type === "dir") {
        await mkdir(full, { mode: 0o700 });
        await own(full);
      } else if (entry.type === "link") {
        await symlink(entry.target, full);
        await own(full);
      } else {
        const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const hash = createHash("sha256");
        let position = 0;
        try {
          await take(entry.size, async (slice) => {
            hash.update(slice);
            let written = 0;
            while (written < slice.length) {
              const { bytesWritten } = await handle.write(slice, written, slice.length - written, position + written);
              written += bytesWritten;
            }
            position += slice.length;
          });
        } finally {
          await handle.close();
        }
        if (hash.digest("hex") !== entry.sha256) throw new Error(`${entry.path} did not come back intact`);
        await chmod(full, entry.mode);
        await own(full);
        await utimes(full, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
      }
    }
    if (piece !== record.pieces.length || offset !== current.length) throw new Error("the stored pieces hold more than the record lists");
    if (stream.digest("hex") !== record.streamSha256) throw new Error("the files did not come back intact");
    for (const entry of [...record.entries].reverse()) {
      if (entry.type !== "dir") continue;
      const full = join(staging, entry.path);
      await chmod(full, entry.mode);
      await utimes(full, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
    }
  };

  const bringBack = async (botId, threadId) => {
    const { botDir, dir } = folderOf(botId, threadId);
    const found = await readMarker(dir);
    if (!found) return { here: true };
    const { text, marker } = found;
    if (marker.botId !== botId || marker.threadId !== threadId) throw new Error("the marker names another chat");
    const room = await free();
    if (room - marker.bytes < lowBytes) return { short: { needBytes: marker.bytes + lowBytes - room, freeBytes: room, bytes: marker.bytes } };
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const staging = join(botDir, `${PREFIX}back.${id}.${threadId}`);
    const gone = join(botDir, `${PREFIX}gone.${id}.${threadId}`);
    let swapped;
    let record;
    try {
      record = parseRecord(await getPiece(marker.record), marker.record);
      if (record.botId !== botId || record.threadId !== threadId) throw new Error("the stored record names another chat");
      await mkdir(staging, { mode: 0o700 });
      await own(staging);
      await build(staging, record);
      swapped = await lock.run(async () => {
        const still = await readMarker(dir).catch(() => null);
        if (still?.text === text && still.alone) {
          await rename(dir, gone);
          try {
            await rename(staging, dir);
          } catch (error) {
            await rename(gone, dir);
            throw error;
          }
          return { back: true };
        }
        const beside = `${threadId}-brought-back-${id.slice(0, 8)}`;
        await rename(staging, join(botDir, beside));
        await chmod(dir, 0o700).catch(() => undefined);
        await own(dir).catch(() => undefined);
        await rm(join(dir, MARKER), { force: true });
        return { back: true, beside };
      });
    } catch (error) {
      await removeTree(staging).catch(() => undefined);
      log(`could not bring back chat ${threadId}'s files yet: ${error.message}; its marker stays and nothing was deleted`);
      throw error;
    }
    await removeTree(gone).catch(() => undefined);
    if (swapped.beside) log(`brought back chat ${threadId}'s files beside its folder as ${swapped.beside}, because something new was written there while they were away`);
    else log(`brought back chat ${threadId}'s files (${record.files} files, ${Math.round(record.bytes / 1024 / 1024)} MB) from Cloud storage`);
    return { ...swapped, files: record.files, bytes: record.bytes };
  };

  const released = async () => {
    const text = await readFile(join(ledgerDir, RELEASED_FILE), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  };

  const release = async (botId, threadId) => {
    const { dir } = folderOf(botId, threadId);
    const found = await readMarker(dir);
    if (!found) return { released: false };
    const { marker } = found;
    if ((await released()).some((row) => row.record === marker.record)) return { released: true, already: true };
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    await own(ledgerDir);
    const file = join(ledgerDir, RELEASED_FILE);
    await appendFile(file, `${JSON.stringify({ botId, threadId, record: marker.record, movedAt: marker.movedAt, bytes: marker.bytes, releasedAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
    await own(file);
    log(`chat ${threadId} was removed while its files were in Cloud storage; recorded that its stored files are no longer needed (they are not deleted)`);
    return { released: true };
  };

  const status = async () => {
    const chats = [];
    const gone = new Set((await released()).map((row) => row.record));
    for (const botId of (await readdir(tasksDir).catch(() => [])).sort()) {
      if (!FOLDER_ID.test(botId) || !await realDirectory(join(tasksDir, botId))) continue;
      for (const threadId of (await readdir(join(tasksDir, botId)).catch(() => [])).sort()) {
        if (!FOLDER_ID.test(threadId)) continue;
        const found = await readMarker(join(tasksDir, botId, threadId)).catch(() => null);
        if (found) chats.push({ botId, threadId, files: found.marker.files, bytes: found.marker.bytes, movedAt: found.marker.movedAt, released: gone.has(found.marker.record) });
      }
    }
    const kept = chats.filter((chat) => !chat.released);
    return { away: kept.length, bytes: kept.reduce((sum, chat) => sum + chat.bytes, 0), released: chats.length - kept.length, chats };
  };

  const recover = async () => {
    const notes = [];
    for (const botId of await readdir(tasksDir).catch(() => [])) {
      const botDir = join(tasksDir, botId);
      if (!FOLDER_ID.test(botId) || !await realDirectory(botDir)) continue;
      for (const name of await readdir(botDir)) {
        const match = /^\.laterdog-restoring-(stub|away|back|gone)\.([a-f0-9]{16})\.([A-Za-z0-9_-]{1,128})$/.exec(name);
        if (!match) continue;
        const [, kind, id, threadId] = match;
        const leftover = join(botDir, name);
        const dir = join(botDir, threadId);
        const present = await lstat(dir).catch(() => null);
        if (kind === "stub" || kind === "back") {
          await removeTree(leftover);
          notes.push(`cleared an unfinished ${kind === "back" ? "return" : "move"} of chat ${threadId}`);
        } else if (!present) {
          await rename(leftover, dir);
          notes.push(`put chat ${threadId}'s ${kind === "away" ? "files" : "marker"} back where they belong after an interrupted ${kind === "away" ? "move" : "return"}`);
        } else if (kind === "gone" || (await readMarker(dir).catch(() => null))) {
          await removeTree(leftover);
          notes.push(`finished clearing chat ${threadId}'s old copy`);
        } else {
          const kept = join(botDir, `${threadId}-kept-${id.slice(0, 8)}`);
          await rename(leftover, kept);
          notes.push(`kept a second copy of chat ${threadId}'s files beside its folder as ${threadId}-kept-${id.slice(0, 8)}`);
        }
      }
    }
    for (const note of notes) log(note);
    return notes;
  };

  return { pack, swap, move, bringBack, release, status, recover, lock };
}
