import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../atomic.ts";
import { LEAST_IDLE_MS } from "./archive-pressure.ts";
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
  inUse(botId: string, threadId: string): boolean;
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
}

export async function measureFolder(dir: string): Promise<FolderSize> {
  const root = await lstat(dir);
  const size: FolderSize = { files: 0, bytes: 0, diskBytes: 0, newestMs: Math.max(root.mtimeMs, root.ctimeMs) };
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      size.newestMs = Math.max(size.newestMs, info.mtimeMs, info.ctimeMs);
      size.diskBytes += info.blocks * 512;
      if (info.isDirectory()) await walk(full);
      else {
        size.files += 1;
        if (info.isFile()) size.bytes += info.size;
      }
    }
  };
  await walk(dir);
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
      if (readFileSync(join(base, "cmdline"), "utf8").split("\0").some(inside)) return true;
    } catch {}
    try {
      if (readFileSync(join(base, "maps"), "utf8").split("\n").some((line) => inside(MAPPED.exec(line)?.[1] ?? ""))) return true;
    } catch {}
  }
  return false;
}

const sameSize = (left: FolderSize, right: FolderSize) => left.files === right.files && left.bytes === right.bytes && left.newestMs === right.newestMs;
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

async function openUpKeepingModes(root: string, at = ""): Promise<Map<string, number>> {
  const modes = new Map<string, number>();
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = at ? `${at}/${entry.name}` : entry.name;
    const mode = (await lstat(join(root, rel))).mode & 0o7777;
    modes.set(rel, mode);
    if ((mode & 0o700) !== 0o700) await chmod(join(root, rel), mode | 0o700);
    for (const [inner, innerMode] of await openUpKeepingModes(root, rel)) modes.set(inner, innerMode);
  }
  return modes;
}

async function mergeInto(from: string, to: string, at: string, moved: string[]): Promise<void> {
  for (const name of await readdir(from)) {
    const source = join(from, name);
    const target = join(to, name);
    const rel = at ? `${at}/${name}` : name;
    const there = await lstat(target).catch(() => null);
    const here = await lstat(source);
    if (!there) {
      await writable(to, () => rename(source, target));
      moved.push(rel);
    } else if (here.isDirectory() && there.isDirectory()) {
      await mergeInto(source, target, rel, moved);
    }
  }
}

async function mergeKeepingModes(staging: string, dir: string): Promise<void> {
  await chmod(staging, 0o700);
  const modes = await openUpKeepingModes(staging);
  const moved: string[] = [];
  await mergeInto(staging, dir, "", moved);
  const fromStaging = (rel: string) => moved.some((root) => rel === root || rel.startsWith(`${root}/`));
  const deepestFirst = [...modes].filter(([rel]) => fromStaging(rel)).sort(([left], [right]) => right.split("/").length - left.split("/").length);
  for (const [rel, mode] of deepestFirst) await chmod(join(dir, rel), mode);
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
  }

  private file(): string {
    return join(this.deps.dataDir, WORK_FOLDER_RECORDS);
  }

  private load(): Record<string, MovedOut> {
    if (this.records) return this.records;
    let found: Record<string, MovedOut> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.file(), "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found = parsed as Record<string, MovedOut>;
    } catch {
      found = {};
    }
    this.records = found;
    return found;
  }

  private save(): void {
    writeFileAtomic(this.file(), JSON.stringify(this.load()), { mode: 0o600 });
  }

  private keyOf(dir: string): string | null {
    const parts = relative(this.deps.workspacesDir, dir).split(sep);
    return parts.length === 2 && parts.every((part) => ID.test(part)) ? parts.join("/") : null;
  }

  private dirOf(key: string): string {
    return join(this.deps.workspacesDir, ...key.split("/"));
  }

  private partPath(key: string, name: string): string {
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
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const child = spawn(this.deps.tar ?? "tar", packArgs(dir), { stdio: ["ignore", "pipe", "pipe"] });
    let complaint = "";
    child.stderr.on("data", (chunk: Buffer) => { complaint = (complaint + chunk.toString()).slice(-400); });
    const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const parts: MovedOutPart[] = [];
    const thread = key.split("/")[1]!;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let written = 0;
    const nameOf = (index: number) => `wf-${thread}-${stamp}-${String(index).padStart(4, "0")}.tar`;
    const finish = async () => {
      if (!handle) return;
      await handle.close();
      handle = null;
      const name = nameOf(parts.length + 1);
      await this.archivePart(key, name, written);
      parts.push({ name, bytes: written });
      written = 0;
    };
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        let rest = chunk;
        while (rest.length) {
          handle ??= await open(join(folder, nameOf(parts.length + 1)), "wx", 0o600);
          const take = rest.subarray(0, partBytes - written);
          await handle.write(take);
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
      if (code !== 0) throw new Error(`tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`);
      return parts;
    } catch (error) {
      child.kill("SIGKILL");
      const unfinished = handle as { close(): Promise<void> } | null;
      if (unfinished) await unfinished.close().catch(() => {});
      await rm(join(folder, nameOf(parts.length + 1)), { force: true }).catch(() => {});
      if (error instanceof Woke) return null;
      throw error;
    }
  }

  private async clear(key: string, record: MovedOut): Promise<void> {
    if (!await this.realFolder(key)) throw new Error("the work folder is not a plain folder inside the workspaces");
    const dir = this.dirOf(key);
    await openUp(dir);
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
    await writeFile(join(dir, MOVED_OUT_NOTE), movedOutNote(record), { mode: 0o600 });
  }

  private idleEnough(chat: WorkspaceTask, limits: WorkFolderLimits): boolean {
    const idleMs = Math.max(limits.idleMs, LEAST_IDLE_MS);
    return !chat.busy && chat.lastActiveAt !== null && chat.lastActiveAt <= this.now() - idleMs;
  }

  private quiet(chat: WorkspaceTask, key: string, limits: WorkFolderLimits): boolean {
    if (!this.idleEnough(chat, limits) || this.wanted.has(key)) return false;
    const [botId, threadId] = key.split("/") as [string, string];
    return !this.deps.inUse(botId, threadId);
  }

  private moveOut(chat: WorkspaceTask, key: string, before: FolderSize, limits: WorkFolderLimits): Promise<number> {
    return this.locked(key, async () => {
      const records = this.load();
      if (records[key]) return 0;
      if (!await this.realFolder(key) || this.held(chat.dir)) return 0;
      const stamp = this.now().toString(36);
      const stillQuiet = () => {
        const current = this.deps.chats().find((candidate) => candidate.dir === chat.dir);
        return Boolean(current && this.quiet(current, key, limits));
      };
      const parts = await this.tarOut(key, chat.dir, stamp, stillQuiet);
      if (!parts || !stillQuiet() || this.held(chat.dir) || !sameSize(before, await measureFolder(chat.dir))) {
        this.log(`laterdog home: left ${key.slice(0, 8)}'s work folder on the disk; the chat woke, a program opened it, or it changed while it was being stored`);
        return 0;
      }
      const record: MovedOut = { stamp, parts, bytes: before.bytes, diskBytes: before.diskBytes, files: before.files, movedAt: this.now(), cleared: false };
      records[key] = record;
      this.save();
      await this.clear(key, record);
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
    const chats = this.deps.chats();
    const known = new Set(chats.map((chat) => this.keyOf(chat.dir)));
    for (const [key, until] of this.leftAlone) if (until <= this.now() || !known.has(key)) this.leftAlone.delete(key);
    let forgotten = 0;
    for (const key of Object.keys(records)) {
      if (known.has(key) && existsSync(this.dirOf(key))) continue;
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
      const record = records[key];
      if (record) {
        if (!record.cleared && !this.held(chat.dir)) {
          await this.locked(key, async () => { await this.clear(key, record); record.cleared = true; this.save(); }).catch(() => {});
        }
        continue;
      }
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
    const present = await lstat(full).catch(() => null);
    if (!present) {
      const result = await this.deps.bridge.restoreContaining([part.name]);
      if (result.failed) throw new Error(`${part.name} did not come back from storage`);
    }
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile() || info.size !== part.bytes) throw new Error(`${part.name} came back incomplete`);
    return full;
  }

  private async unpack(key: string, record: MovedOut, staging: string): Promise<void> {
    const child = spawn(this.deps.tar ?? "tar", unpackArgs(staging), { stdio: ["pipe", "ignore", "pipe"] });
    let complaint = "";
    child.stderr.on("data", (chunk: Buffer) => { complaint = (complaint + chunk.toString()).slice(-400); });
    const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    child.stdin.on("error", () => {});
    const restored: string[] = [];
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
        await rm(full, { force: true });
      }
      child.stdin.end();
      const code = await ended;
      if (code !== 0) throw new Error(`tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`);
    } catch (error) {
      child.kill("SIGKILL");
      for (const full of restored) await rm(full, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async dropStaging(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      if (!name.startsWith(RESTORING_PREFIX)) continue;
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
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!await this.realFolder(key)) throw new Error("the work folder is not a plain folder inside the workspaces");
      await this.dropStaging(dir);
      const note = join(dir, MOVED_OUT_NOTE);
      const staging = join(dir, `${RESTORING_PREFIX}${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await this.unpack(key, record, staging);
        if (await readFile(note, "utf8").catch(() => null) === movedOutNote(record)) await rm(note, { force: true });
        await mergeKeepingModes(staging, dir);
      } finally {
        await openUp(staging).catch(() => {});
        await rm(staging, { recursive: true, force: true });
      }
      delete records[key];
      this.save();
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
