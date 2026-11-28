import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../atomic.ts";
import { LEAST_IDLE_MS } from "./archive-pressure.ts";
import { hasLiveWork } from "./disk-ladder.ts";
import type { ProcessInfo } from "./process-reaper.ts";
import type { WorkspaceTask } from "./janitor.ts";
import type { ArchiveSkip } from "./log-archive.ts";

export const WORK_FOLDER_PARTS = ".laterdog/checkpoints/work-folders";
export const WORK_FOLDER_RECORDS = "work-folders.json";
export const MOVED_OUT_NOTE = "MOVED-OUT.md";
export const RESTORING_PREFIX = ".laterdog-restoring-";
export const PART_BYTES = 32 * 1024 * 1024;
export const ROOM_WAIT_MS = 3 * 60_000;
export const SPARSE_GAP_BYTES = 256 * 1024 * 1024;
export const LEFT_ALONE_MS = 10 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAPPED = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\S.*)$/;

export function packArgs(dir: string): string[] {
  return ["-c", "-f", "-", "-C", dir, "."];
}

export function unpackArgs(dir: string): string[] {
  return ["-x", "-p", "-f", "-", "-C", dir];
}

export interface MovedOutPart {
  sha256?: string;
  name: string;
  bytes: number;
}

export interface MovedOut {
  stamp: string;
  parts: MovedOutPart[];
  bytes: number;
  diskBytes?: number;
  files: number;
  movedAt: number;
  cleared: boolean;
}

export interface WorkFolderLimits {
  idleMs: number;
  byteLimit: number;
  minBytes: number;
  minFiles: number;
}

export interface WorkFolderBridge {
  archive(paths: string[], bytes?: number): Promise<{ archived: number; bytes: number; skipped?: ArchiveSkip[] }>;
  restoreContaining(needles: string[]): Promise<{ restored: number; failed: number }>;
}

export interface WorkFolderDeps {
  home: string;
  dataDir: string;
  workspacesDir: string;
  bridge: WorkFolderBridge;
  chats(): WorkspaceTask[];
  chatsInSlices?(): Promise<WorkspaceTask[]>;
  chat?(dir: string): WorkspaceTask | undefined;
  syncDirectory?(dir: string): Promise<void>;
  live?(): ProcessInfo[];
  inUse?(botId: string, threadId: string): boolean;
  limits(): WorkFolderLimits;
  room(bytes: number): boolean;
  makeRoom?(): Promise<void>;
  procDir?: string;
  now?: () => number;
  log?(line: string): void;
  onWaitStarted?(botId: string, threadId: string): void;
  onWaitEnded?(botId: string, threadId: string, outcome: "acquired" | "stopped", waitedMs: number): void;
  retryMs?: number;
  waitMs?: number;
  partBytes?: number;
  tar?: string;
}

export interface FolderSize {
  files: number;
  bytes: number;
  diskBytes: number;
  newestMs: number;
  fingerprint: string;
}

export async function measureFolder(dir: string): Promise<FolderSize> {
  const root = await lstat(dir);
  const size: FolderSize = { files: 0, bytes: 0, diskBytes: 0, newestMs: Math.max(root.mtimeMs, root.ctimeMs), fingerprint: "" };
  const fingerprint = createHash("sha256");
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      size.newestMs = Math.max(size.newestMs, info.mtimeMs, info.ctimeMs);
      fingerprint.update(JSON.stringify([relative(dir, full), info.mode, info.ino, info.dev, info.size, info.mtimeMs, info.ctimeMs, info.isSymbolicLink() ? await readlink(full) : null]));
      size.diskBytes += info.blocks * 512;
      if (info.isDirectory()) await walk(full);
      else {
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error("unsupported work folder entry");
        size.files += 1;
        if (info.isFile()) size.bytes += info.size;
      }
    }
  };
  await walk(dir);
  size.fingerprint = fingerprint.digest("hex");
  return size;
}

export function folderHeld(dir: string, procDir = "/proc"): boolean {
  let pids: string[];
  try { pids = readdirSync(procDir).filter((name) => /^\d+$/.test(name)); } catch { return true; }
  const inside = (path: string) => path === dir || path.startsWith(`${dir}/`);
  const link = (path: string) => { try { return readlinkSync(path); } catch { return ""; } };
  for (const pid of pids) {
    const base = join(procDir, pid);
    if (inside(link(join(base, "cwd"))) || inside(link(join(base, "exe")))) return true;
    let fds: string[] = [];
    try { fds = readdirSync(join(base, "fd")); } catch {}
    if (fds.some((fd) => inside(link(join(base, "fd", fd))))) return true;
    try {
      if (readFileSync(join(base, "cmdline"), "utf8").split("\0").some(arg => inside(arg) || arg.includes(dir))) return true;
    } catch {}
    try {
      if (readFileSync(join(base, "maps"), "utf8").split("\n").some((line) => inside(MAPPED.exec(line)?.[1] ?? ""))) return true;
    } catch {}
  }
  return false;
}

const sameSize = (left: FolderSize, right: FolderSize) => left.files === right.files && left.bytes === right.bytes && left.newestMs === right.newestMs && left.fingerprint === right.fingerprint;
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sized = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : mb(bytes));

export function movedOutNote(record: Pick<MovedOut, "movedAt" | "bytes" | "files">): string {
  return [
    "# This chat's files are in storage",
    "",
    `later.dog moved ${record.files} file(s), ${mb(record.bytes)}, off the disk on ${new Date(record.movedAt).toISOString().slice(0, 10)} to make room, because this chat had been quiet.`,
    "They come back by themselves when the chat's next turn starts. Nothing was deleted.",
    "",
  ].join("\n");
}

function validKey(key: string): boolean {
  const parts = key.split("/");
  return parts.length === 2 && parts.every(part => ID.test(part));
}

function validRecord(key: string, value: unknown): value is MovedOut {
  if (!validKey(key) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as MovedOut;
  const count = (number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (typeof record.stamp !== "string" || !/^[a-z0-9-]{1,80}$/.test(record.stamp)
    || (record.diskBytes !== undefined && !count(record.diskBytes)) || !count(record.bytes) || !count(record.files) || !count(record.movedAt) || typeof record.cleared !== "boolean"
    || !Array.isArray(record.parts) || !record.parts.length) return false;
  const thread = key.split("/")[1]!;
  return record.parts.every((part, index) => part && typeof part === "object"
    && part.name === `wf-${thread}-${record.stamp}-${String(index + 1).padStart(4, "0")}.tar`
    && count(part.bytes) && part.bytes > 0 && part.bytes <= PART_BYTES
    && (part.sha256 === undefined && /^[a-z0-9]+$/.test(record.stamp) || typeof part.sha256 === "string" && /^[a-f0-9]{64}$/.test(part.sha256)));
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export function roomNeeded(record: Pick<MovedOut, "parts" | "diskBytes">, partBytes = PART_BYTES): number {
  const packed = record.parts.reduce((sum, part) => sum + part.bytes, 0);
  return Math.max(packed, record.diskBytes ?? 0) + Math.min(partBytes, packed);
}

export class WorkFolderUnavailable extends Error {}

class NoRoom extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super("no room");
    this.bytes = bytes;
  }
}
class Woke extends Error {}

async function writable<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o300) === 0o300) return action();
  await chmod(dir, info.mode | 0o700);
  try {
    return await action();
  } finally {
    await chmod(dir, info.mode & 0o7777).catch(() => {});
  }
}

async function openUp(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) await chmod(dir, info.mode | 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await openUp(join(dir, entry.name));
}

export class WorkFolderArchive {
  private records: Record<string, MovedOut> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private sweeping: Promise<number> | null = null;
  private totals = { movedOut: 0, movedOutBytes: 0, broughtBack: 0, broughtBackBytes: 0, lastSweepAt: null as number | null };
  private sinceSweep = { broughtBack: 0, broughtBackBytes: 0 };
  private wanted = new Map<string, number>();
  private leftAlone = new Map<string, number>();
  private readonly deps: WorkFolderDeps;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(deps: WorkFolderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    if (!Number.isSafeInteger(deps.partBytes ?? PART_BYTES) || (deps.partBytes ?? PART_BYTES) < 1 || (deps.partBytes ?? PART_BYTES) > PART_BYTES) throw new Error("invalid work folder part size");
  }

  private file(): string {
    return join(this.deps.dataDir, WORK_FOLDER_RECORDS);
  }

  private safeDir(dir: string, make = false): void {
    const home = resolve(this.deps.home);
    const path = relative(home, resolve(dir));
    if (realpathSync(home) !== home || isAbsolute(path) || path.split(sep).some(part => part === "..")) throw new Error("unsafe work folder path");
    let at = home;
    for (const part of path.split(sep).filter(Boolean)) {
      at = join(at, part);
      if (make) {
        try { mkdirSync(at, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const info = lstatSync(at);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe work folder parent");
    }
  }

  private load(): Record<string, MovedOut> {
    if (this.records) return this.records;
    this.safeDir(this.deps.dataDir);
    let parsed: unknown;
    try {
      const file = this.file();
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid work folder record file");
      parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Object.entries(parsed).every(([key, value]) => validRecord(key, value))) throw new Error("invalid work folder record");
    this.records = Object.assign(Object.create(null) as Record<string, MovedOut>, parsed);
    return this.records;
  }

  private save(): void {
    this.safeDir(this.deps.dataDir);
    writeFileAtomic(this.file(), JSON.stringify(this.load()), { mode: 0o600 });
    const fd = openSync(this.deps.dataDir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private keyOf(dir: string): string | null {
    const parts = relative(this.deps.workspacesDir, dir).split(sep);
    return parts.length === 2 && parts.every((part) => ID.test(part)) ? parts.join("/") : null;
  }

  private dirOf(key: string): string {
    if (!validKey(key)) throw new Error("invalid work folder key");
    return join(this.deps.workspacesDir, ...key.split("/"));
  }

  private partPath(key: string, name: string): string {
    if (!validKey(key) || !/^[A-Za-z0-9_-]+[.]tar$/.test(name)) throw new Error("invalid work folder part path");
    return `${WORK_FOLDER_PARTS}/${key.split("/")[0]}/${name}`;
  }

  private async realFolder(key: string): Promise<boolean> {
    const dir = this.dirOf(key);
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory()) return false;
    const base = await realpath(this.deps.workspacesDir).catch(() => null);
    return Boolean(base) && (await realpath(dir).catch(() => null)) === join(base!, ...key.split("/"));
  }

  private held(dir: string): boolean {
    return folderHeld(dir, this.deps.procDir);
  }

  private locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(key, next);
    return next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); });
  }

  status() {
    const records = Object.values(this.load());
    return { enabled: true, out: records.length, outBytes: records.reduce((sum, record) => sum + record.bytes, 0), ...this.totals };
  }

  movedOut(botId: string, threadId: string): MovedOut | null {
    return this.load()[`${botId}/${threadId}`] ?? null;
  }

  private async archivePart(key: string, name: string, bytes: number): Promise<void> {
    const path = this.partPath(key, name);
    const result = await this.deps.bridge.archive([path], bytes);
    if (result.archived !== 1) throw new Error(`the archive kept ${name} (${result.skipped?.[0]?.why ?? "no reason given"})`);
  }

  private async tarOut(key: string, dir: string, stamp: string, stillQuiet: () => boolean): Promise<MovedOutPart[] | null> {
    const partBytes = this.deps.partBytes ?? PART_BYTES;
    const folder = join(this.deps.home, WORK_FOLDER_PARTS, key.split("/")[0]!);
    this.safeDir(folder, true);
    this.safeDir(dir);
    const child = spawn(this.deps.tar ?? "tar", packArgs(dir), { stdio: ["ignore", "pipe", "pipe"] });
    let complaint = "";
    child.stderr.on("data", (chunk: Buffer) => { complaint = (complaint + chunk.toString()).slice(-400); });
    let spawnError: Error | null = null;
    child.once("error", error => { spawnError = error; });
    const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const parts: MovedOutPart[] = [];
    const thread = key.split("/")[1]!;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let written = 0;
    let hash = createHash("sha256");
    const nameOf = (index: number) => `wf-${thread}-${stamp}-${String(index).padStart(4, "0")}.tar`;
    const finish = async () => {
      if (!handle) return;
      await handle.sync();
      await handle.close();
      handle = null;
      const name = nameOf(parts.length + 1);
      await this.archivePart(key, name, written);
      parts.push({ name, bytes: written, sha256: hash.digest("hex") });
      hash = createHash("sha256");
      written = 0;
    };
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        let rest = chunk;
        while (rest.length) {
          handle ??= await open(join(folder, nameOf(parts.length + 1)), "wx", 0o600);
          const take = rest.subarray(0, partBytes - written);
          await handle.writeFile(take);
          hash.update(take);
          written += take.length;
          rest = rest.subarray(take.length);
          if (written >= partBytes) {
            await finish();
            if (!stillQuiet()) throw new Woke();
          }
        }
      }
      await finish();
      const code = await ended;
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error(`tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`);
      return parts;
    } catch (error) {
      child.kill("SIGKILL");
      await ended;
      const unfinished = handle as { close(): Promise<void> } | null;
      if (unfinished) await unfinished.close().catch(() => {});
      try {
        this.safeDir(folder);
        await rm(join(folder, nameOf(parts.length + 1)), { force: true });
      } catch {}
      if (error instanceof Woke) return null;
      throw error;
    }
  }

  private async clear(dir: string, record: MovedOut, stillQuiet: () => boolean): Promise<void> {
    this.safeDir(dir);
    for (const name of await readdir(dir)) {
      if (!stillQuiet()) throw new Woke();
      this.safeDir(dir);
      await openUp(join(dir, name));
      if (!stillQuiet()) throw new Woke();
      await rm(join(dir, name), { recursive: true, force: true });
    }
    this.safeDir(dir);
    await writeFile(join(dir, MOVED_OUT_NOTE), movedOutNote(record), { mode: 0o600 });
  }

  private idleEnough(chat: WorkspaceTask, limits: WorkFolderLimits): boolean {
    const idleMs = Math.max(limits.idleMs, LEAST_IDLE_MS);
    return !chat.busy && chat.lastActiveAt !== null && chat.lastActiveAt <= this.now() - idleMs;
  }

  private quiet(chat: WorkspaceTask, key: string, limits: WorkFolderLimits): boolean {
    if (!this.idleEnough(chat, limits) || this.wanted.has(key)) return false;
    const [botId, threadId] = key.split("/") as [string, string];
    return !this.deps.inUse?.(botId, threadId) && !hasLiveWork(chat, this.deps.live?.() ?? []);
  }

  private moveOut(chat: WorkspaceTask, key: string, before: FolderSize, limits: WorkFolderLimits): Promise<number> {
    return this.locked(key, async () => {
      const records = this.load();
      if (records[key]) return 0;
      if (!await this.realFolder(key) || this.held(chat.dir)) return 0;
      const stamp = `${this.now().toString(36)}-${randomUUID()}`;
      const stillQuiet = () => {
        const current = this.deps.chat ? this.deps.chat(chat.dir) : this.deps.chats().find((candidate) => candidate.dir === chat.dir);
        return Boolean(current && this.quiet(current, key, limits));
      };
      if (!stillQuiet()) return 0;
      const parts = await this.tarOut(key, chat.dir, stamp, stillQuiet);
      if (!parts || !stillQuiet() || this.held(chat.dir) || !sameSize(before, await measureFolder(chat.dir))) {
        this.log(`laterdog home: left ${key.slice(0, 8)}'s work folder on the disk; the chat woke, a program opened it, or it changed while it was being stored`);
        return 0;
      }
      const record: MovedOut = { stamp, parts, bytes: before.bytes, diskBytes: before.diskBytes, files: before.files, movedAt: this.now(), cleared: false };
      records[key] = record;
      this.save();
      await this.clear(chat.dir, record, () => stillQuiet() && !this.held(chat.dir));
      record.cleared = true;
      this.save();
      this.totals.movedOut += 1;
      this.totals.movedOutBytes += before.diskBytes;
      return before.diskBytes;
    });
  }

  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<number> {
    const limits = this.deps.limits();
    const records = this.load();
    this.totals.lastSweepAt = this.now();
    const chats = this.deps.chatsInSlices ? await this.deps.chatsInSlices() : this.deps.chats();
    const known = new Set(chats.map((chat) => this.keyOf(chat.dir)));
    for (const [key, until] of this.leftAlone) if (until <= this.now() || !known.has(key)) this.leftAlone.delete(key);
    let forgotten = 0;
    for (const key of Object.keys(records)) {
      if (known.has(key)) continue;
      delete records[key];
      forgotten += 1;
    }
    if (forgotten) this.save();
    const waiting = chats
      .filter((chat) => this.idleEnough(chat, limits))
      .sort((left, right) => (left.lastActiveAt ?? 0) - (right.lastActiveAt ?? 0));
    let remaining = limits.byteLimit;
    let freed = 0;
    let moved = 0;
    let failures = 0;
    for (const chat of waiting) {
      const key = this.keyOf(chat.dir);
      if (remaining <= 0 || failures >= 3) break;
      if (!key || !this.quiet(chat, key, limits)) continue;
      if (records[key]) continue;
      if ((this.leftAlone.get(key) ?? 0) > this.now()) continue;
      if (!await this.realFolder(key)) continue;
      const rest = () => { this.leftAlone.set(key, this.now() + LEFT_ALONE_MS); };
      let size: FolderSize;
      try { size = await measureFolder(chat.dir); } catch { rest(); continue; }
      if (size.diskBytes < limits.minBytes && size.files < limits.minFiles) continue;
      if (size.bytes - size.diskBytes > SPARSE_GAP_BYTES) {
        rest();
        continue;
      }
      if (size.diskBytes > remaining && remaining !== limits.byteLimit) continue;
      try {
        const bytes = await this.moveOut(chat, key, size, limits);
        if (!bytes) {
          rest();
          continue;
        }
        remaining -= bytes;
        freed += bytes;
        moved += 1;
        failures = 0;
      } catch (error) {
        failures += 1;
        this.log(`laterdog home: could not store ${key.slice(0, 8)}'s work folder: ${said(error)}`);
      }
    }
    const back = this.sinceSweep;
    this.sinceSweep = { broughtBack: 0, broughtBackBytes: 0 };
    if (moved || back.broughtBack) {
      this.log(`laterdog home: work folder sweep: ${moved} folder(s), ${mb(freed)} left the disk; ${back.broughtBack} folder(s), ${mb(back.broughtBackBytes)} came back since the last sweep`);
    }
    return freed;
  }

  private async restorePart(key: string, part: MovedOutPart): Promise<string> {
    const full = join(this.deps.home, this.partPath(key, part.name));
    this.safeDir(dirname(full), true);
    let present = await lstat(full).catch(() => null);
    if (present && !present.isFile()) throw new Error("unsafe work folder part");
    let preserved: string | undefined;
    if (present && (present.size !== part.bytes || part.sha256 === undefined || await fileHash(full) !== part.sha256)) {
      this.safeDir(dirname(full));
      if (part.sha256 === undefined) {
        preserved = `${full}.unverified-${randomUUID()}`;
        await link(full, preserved);
      }
      await rm(full);
      present = null;
    }
    try {
      if (!present) {
        const result = await this.deps.bridge.restoreContaining([part.name]);
        if (result.failed || (!part.sha256 && result.restored !== 1)) throw new Error(`${part.name} did not come back from storage`);
      }
      this.safeDir(dirname(full));
      const info = await lstat(full).catch(() => null);
      if (!info?.isFile() || info.size !== part.bytes || (part.sha256 !== undefined && await fileHash(full) !== part.sha256)) throw new Error(`${part.name} came back incomplete`);
    } catch (error) {
      if (preserved) {
        this.safeDir(dirname(full));
        await link(preserved, full).then(() => rm(preserved!)).catch(() => {});
      }
      throw error;
    }
    if (preserved) await rm(preserved);
    return full;
  }

  private async syncDirectory(dir: string): Promise<void> {
    this.safeDir(dir);
    if (this.deps.syncDirectory) return this.deps.syncDirectory(dir);
    const handle = await open(dir, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async syncParents(dir: string): Promise<void> {
    let at = resolve(dir);
    const home = resolve(this.deps.home);
    for (;;) {
      await this.syncDirectory(at);
      if (at === home) return;
      at = dirname(at);
    }
  }

  private async syncTree(dir: string): Promise<void> {
    this.safeDir(dir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await this.syncTree(path);
      else if (entry.isFile()) {
        const handle = await open(path, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    await this.syncDirectory(dir);
  }

  private async mergeRestored(source: string, target: string, names?: readonly string[]): Promise<void> {
    this.safeDir(source);
    this.safeDir(target);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (names && !names.includes(entry.name)) continue;
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isDirectory()) {
        let made = false;
        try { await writable(target, () => mkdir(to, { mode: 0o700 })); made = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.safeDir(to);
        await this.mergeRestored(from, to);
        if (made) {
          await chmod(to, (await lstat(from)).mode & 0o777);
          await this.syncDirectory(to);
        }
      } else {
        this.safeDir(target);
        try {
          if (entry.isSymbolicLink()) {
            const path = await readlink(from);
            await writable(target, () => symlink(path, to));
          } else if (entry.isFile()) await writable(target, () => link(from, to));
          else throw new Error("unsupported restored work folder entry");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    }
    this.safeDir(target);
    await this.syncDirectory(target);
  }

  private async restoreNote(dir: string, scratch: string, record: MovedOut): Promise<void> {
    this.safeDir(scratch);
    const pending = join(scratch, "storage-note");
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(movedOutNote(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.safeDir(dir);
    try {
      await link(pending, join(dir, MOVED_OUT_NOTE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    await this.syncDirectory(dir);
  }

  private async unpack(key: string, record: MovedOut, staging: string): Promise<void> {
    const child = spawn(this.deps.tar ?? "tar", unpackArgs(staging), { stdio: ["pipe", "ignore", "pipe"] });
    let complaint = "";
    child.stderr.on("data", (chunk: Buffer) => { complaint = (complaint + chunk.toString()).slice(-400); });
    const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    child.stdin.on("error", () => {});
    const restored: string[] = [];
    let spawnError: Error | null = null;
    child.once("error", error => { spawnError = error; });
    const stopped = ended.then((code) => ({ code }));
    try {
      for (const [index, part] of record.parts.entries()) {
        const full = await this.restorePart(key, part);
        restored.push(full);
        const source = createReadStream(full);
        const piped = new Promise<null>((resolve, reject) => {
          source.once("error", reject);
          source.once("end", () => resolve(null));
          source.pipe(child.stdin, { end: false });
        });
        const early = await Promise.race([piped, stopped]);
        if (early) {
          source.destroy();
          if (early.code !== 0 || index !== record.parts.length - 1) {
            throw new Error(`tar stopped early with code ${early.code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`);
          }
        }
        this.safeDir(dirname(full));
        await rm(full, { force: true });
      }
      child.stdin.end();
      const code = await ended;
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error(`tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`);
    } catch (error) {
      child.kill("SIGKILL");
      await ended;
      for (const full of restored) {
        this.safeDir(dirname(full));
        await rm(full, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  private async dropStaging(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      if (!name.startsWith(RESTORING_PREFIX) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name.slice(RESTORING_PREFIX.length))) continue;
      await openUp(join(dir, name)).catch(() => {});
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }

  private bringBack(key: string): Promise<boolean> {
    return this.locked(key, async () => {
      const records = this.load();
      const record = records[key];
      if (!record) return false;
      const need = roomNeeded(record, this.deps.partBytes);
      if (!this.deps.room(need)) throw new NoRoom(need);
      const dir = this.dirOf(key);
      const existed = await lstat(dir).catch(() => null);
      this.safeDir(dir, true);
      await this.dropStaging(dir);
      const scratch = await mkdtemp(join(dirname(dir), `.restoring-${key.split("/")[1]}-`));
      const staging = join(scratch, "files");
      await mkdir(staging, { mode: 0o700 });
      let removedNote = false;
      try {
        await this.unpack(key, record, staging);
        await this.syncTree(staging);
        const names = (await readdir(staging)).filter(name => name !== MOVED_OUT_NOTE);
        await this.mergeRestored(staging, dir, names);
        await this.syncParents(dir);
        const note = join(dir, MOVED_OUT_NOTE);
        if ((await lstat(note).catch(() => null))?.isFile() && readFileSync(note, "utf8") === movedOutNote(record)) {
          this.safeDir(dir);
          await rm(note);
          removedNote = true;
        }
        await this.mergeRestored(staging, dir, [MOVED_OUT_NOTE]);
        if (!existed) await chmod(dir, (await lstat(staging)).mode & 0o777);
        await this.syncParents(dir);
        this.safeDir(dir);
        delete records[key];
        this.save();
      } catch (error) {
        if (!records[key]) {
          records[key] = record;
          try { this.save(); } catch (saveError) { this.log(`laterdog home: could not keep restore record: ${said(saveError)}`); }
        }
        if (removedNote) {
          await this.restoreNote(dir, scratch, record).catch(noteError => this.log(`laterdog home: could not put storage note back: ${said(noteError)}`));
        }
        throw error;
      } finally {
        this.safeDir(dirname(scratch));
        await openUp(scratch).catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(error => this.log(`laterdog home: could not remove restore scratch: ${said(error)}`));
      }
      await rmdir(join(this.deps.home, WORK_FOLDER_PARTS, key.split("/")[0]!)).catch(() => {});
      this.totals.broughtBack += 1;
      this.totals.broughtBackBytes += record.diskBytes ?? record.bytes;
      this.sinceSweep.broughtBack += 1;
      this.sinceSweep.broughtBackBytes += record.diskBytes ?? record.bytes;
      this.log(`laterdog home: brought ${key.slice(0, 8)}'s work folder back from storage, ${mb(record.bytes)}`);
      return true;
    });
  }

  async beforeTurn(botId: string, threadId: string, current: () => boolean = () => true): Promise<boolean> {
    const key = `${botId}/${threadId}`;
    if (!validKey(key)) throw new Error("invalid work folder key");
    this.wanted.set(key, (this.wanted.get(key) ?? 0) + 1);
    try {
      await this.locked(key, async () => {});
      if (!this.load()[key]) return current();
      return await this.waitForFolder(botId, threadId, key, current);
    } finally {
      const left = (this.wanted.get(key) ?? 1) - 1;
      if (left > 0) this.wanted.set(key, left);
      else this.wanted.delete(key);
    }
  }

  private async waitForFolder(botId: string, threadId: string, key: string, current: () => boolean): Promise<boolean> {
    const started = this.now();
    let warned = false;
    let waiting = false;
    const stopWaiting = (outcome: "acquired" | "stopped") => {
      if (!waiting) return;
      waiting = false;
      this.deps.onWaitEnded?.(botId, threadId, outcome, Math.max(0, this.now() - started));
    };
    try {
      while (current()) {
        const record = this.load()[key];
        if (!record) {
          stopWaiting("acquired");
          return true;
        }
        if (!waiting) {
          waiting = true;
          this.deps.onWaitStarted?.(botId, threadId);
        }
        try {
          const need = roomNeeded(record, this.deps.partBytes);
          if (!this.deps.room(need)) {
            await this.deps.makeRoom?.();
            if (!this.deps.room(need)) throw new NoRoom(need);
          }
          await this.bringBack(key);
          const ok = current();
          stopWaiting(ok ? "acquired" : "stopped");
          return ok;
        } catch (error) {
          if (this.now() - started >= (this.deps.waitMs ?? ROOM_WAIT_MS)) {
            this.log(`laterdog home: stopped a turn in ${key.slice(0, 8)}; its work folder could not come back (${error instanceof NoRoom ? `no room for ${mb(error.bytes)}` : said(error)})`);
            throw new WorkFolderUnavailable(error instanceof NoRoom
              ? `There is no room on this home's disk to bring back this chat's ${sized(error.bytes)} of files from storage; delete files or chats you no longer need, then send your message again.`
              : "This chat's files are in storage and did not come back in time; send your message again in a few minutes.");
          }
          if (!warned) {
            this.log(error instanceof NoRoom
              ? `laterdog home: no room to bring ${key.slice(0, 8)}'s work folder back; making room and keeping the pending turn`
              : `laterdog home: ${key.slice(0, 8)}'s work folder is not back yet (${said(error)}); keeping the pending turn and retrying`);
          }
          warned = true;
          await delay(this.deps.retryMs ?? 5000);
        }
      }
      stopWaiting("stopped");
      return false;
    } catch (error) {
      stopWaiting("stopped");
      throw error;
    }
  }
}
