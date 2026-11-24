import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../atomic.ts";
import { hasLiveWork } from "./disk-ladder.ts";
import type { WorkspaceTask } from "./janitor.ts";
import type { ArchiveSkip } from "./log-archive.ts";
import type { ProcessInfo } from "./process-reaper.ts";

export const WORK_FOLDER_PARTS = ".laterdog/checkpoints/work-folders";
export const WORK_FOLDER_RECORDS = "work-folders.json";
export const MOVED_OUT_NOTE = "MOVED-OUT.md";
export const PART_BYTES = 32 * 1024 * 1024;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface MovedOutPart {
  name: string;
  bytes: number;
}

export interface MovedOut {
  stamp: string;
  parts: MovedOutPart[];
  bytes: number;
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
  live(): ProcessInfo[];
  limits(): WorkFolderLimits;
  room(bytes: number): boolean;
  makeRoom?(): Promise<void>;
  now?: () => number;
  log?(line: string): void;
  retryMs?: number;
  partBytes?: number;
  tar?: string;
}

export interface FolderSize {
  files: number;
  bytes: number;
  newestMs: number;
}

export async function measureFolder(dir: string): Promise<FolderSize> {
  const size: FolderSize = { files: 0, bytes: 0, newestMs: 0 };
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      size.newestMs = Math.max(size.newestMs, info.mtimeMs);
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

const sameSize = (left: FolderSize, right: FolderSize) => left.files === right.files && left.bytes === right.bytes && left.newestMs === right.newestMs;
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function movedOutNote(record: Pick<MovedOut, "movedAt" | "bytes" | "files">): string {
  return [
    "# This chat's files are in storage",
    "",
    `later.dog moved ${record.files} file(s), ${mb(record.bytes)}, off the disk on ${new Date(record.movedAt).toISOString().slice(0, 10)} to make room, because this chat had been quiet.`,
    "They come back by themselves when the chat's next turn starts. Nothing was deleted.",
    "",
  ].join("\n");
}

class NoRoom extends Error {}
class Woke extends Error {}

export class WorkFolderArchive {
  private records: Record<string, MovedOut> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private sweeping: Promise<number> | null = null;
  private totals = { movedOut: 0, movedOutBytes: 0, broughtBack: 0, broughtBackBytes: 0, lastSweepAt: null as number | null };
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
    const child = spawn(this.deps.tar ?? "tar", ["-cf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "pipe"] });
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

  private async clear(dir: string, record: MovedOut): Promise<void> {
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
    await writeFile(join(dir, MOVED_OUT_NOTE), movedOutNote(record), { mode: 0o600 });
  }

  private eligible(chat: WorkspaceTask, limits: WorkFolderLimits, live: readonly ProcessInfo[]): boolean {
    if (chat.busy || chat.lastActiveAt === null || chat.lastActiveAt > this.now() - limits.idleMs) return false;
    return !hasLiveWork(chat, live);
  }

  private moveOut(chat: WorkspaceTask, key: string, before: FolderSize): Promise<number> {
    return this.locked(key, async () => {
      const records = this.load();
      if (records[key]) return 0;
      const stamp = this.now().toString(36);
      const stillQuiet = () => {
        const current = this.deps.chats().find((candidate) => candidate.dir === chat.dir);
        return Boolean(current && this.eligible(current, this.deps.limits(), this.deps.live()));
      };
      const parts = await this.tarOut(key, chat.dir, stamp, stillQuiet);
      if (!parts || !stillQuiet() || !sameSize(before, await measureFolder(chat.dir))) {
        this.log(`laterdog home: left ${key.slice(0, 8)}'s work folder on the disk; the chat woke or the folder changed while it was being stored`);
        return 0;
      }
      const record: MovedOut = { stamp, parts, bytes: before.bytes, files: before.files, movedAt: this.now(), cleared: false };
      records[key] = record;
      this.save();
      await this.clear(chat.dir, record);
      record.cleared = true;
      this.save();
      this.totals.movedOut += 1;
      this.totals.movedOutBytes += before.bytes;
      return before.bytes;
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
    let forgotten = 0;
    for (const key of Object.keys(records)) {
      if (known.has(key) && existsSync(this.dirOf(key))) continue;
      delete records[key];
      forgotten += 1;
    }
    if (forgotten) this.save();
    const live = this.deps.live();
    const waiting = chats
      .filter((chat) => this.eligible(chat, limits, live))
      .sort((left, right) => (left.lastActiveAt ?? 0) - (right.lastActiveAt ?? 0));
    let remaining = limits.byteLimit;
    let freed = 0;
    let moved = 0;
    let failures = 0;
    for (const chat of waiting) {
      const key = this.keyOf(chat.dir);
      if (!key || remaining <= 0 || failures >= 3) break;
      const record = records[key];
      if (record) {
        if (!record.cleared) await this.locked(key, async () => { await this.clear(chat.dir, record); record.cleared = true; this.save(); }).catch(() => {});
        continue;
      }
      let size: FolderSize;
      try { size = await measureFolder(chat.dir); } catch { continue; }
      if (size.bytes < limits.minBytes && size.files < limits.minFiles) continue;
      if (size.bytes > remaining && remaining !== limits.byteLimit) continue;
      try {
        const bytes = await this.moveOut(chat, key, size);
        if (!bytes) continue;
        remaining -= bytes;
        freed += bytes;
        moved += 1;
        failures = 0;
      } catch (error) {
        failures += 1;
        this.log(`laterdog home: could not store ${key.slice(0, 8)}'s work folder: ${said(error)}`);
      }
    }
    if (moved) this.log(`laterdog home: moved ${moved} quiet chat(s)' work folders into storage, freed ${mb(freed)}`);
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

  private bringBack(key: string): Promise<boolean> {
    return this.locked(key, async () => {
      const records = this.load();
      const record = records[key];
      if (!record) return false;
      if (!this.deps.room(record.bytes)) {
        await this.deps.makeRoom?.();
        if (!this.deps.room(record.bytes)) throw new NoRoom();
      }
      const dir = this.dirOf(key);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const child = spawn(this.deps.tar ?? "tar", ["-xf", "-", "--keep-newer-files", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
      let complaint = "";
      child.stderr.on("data", (chunk: Buffer) => { complaint = (complaint + chunk.toString()).slice(-400); });
      const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
      child.stdin.on("error", () => {});
      const restored: string[] = [];
      try {
        for (const part of record.parts) {
          const full = await this.restorePart(key, part);
          restored.push(full);
          await new Promise<void>((resolve, reject) => {
            const source = createReadStream(full);
            source.once("error", reject);
            source.once("end", resolve);
            source.pipe(child.stdin, { end: false });
          });
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
      await rm(join(dir, MOVED_OUT_NOTE), { force: true });
      delete records[key];
      this.save();
      await rmdir(join(this.deps.home, WORK_FOLDER_PARTS, key.split("/")[0]!)).catch(() => {});
      this.totals.broughtBack += 1;
      this.totals.broughtBackBytes += record.bytes;
      this.log(`laterdog home: brought ${key.slice(0, 8)}'s work folder back from storage, ${mb(record.bytes)}`);
      return true;
    });
  }

  async beforeTurn(botId: string, threadId: string, current: () => boolean = () => true): Promise<boolean> {
    const key = `${botId}/${threadId}`;
    let warned = false;
    while (current()) {
      if (!this.load()[key]) return true;
      try {
        await this.bringBack(key);
        return current();
      } catch (error) {
        if (!warned) {
          this.log(error instanceof NoRoom
            ? `laterdog home: no room to bring ${key.slice(0, 8)}'s work folder back; making room and keeping the pending turn`
            : `laterdog home: ${key.slice(0, 8)}'s work folder is not back yet (${said(error)}); keeping the pending turn and retrying`);
        }
        warned = true;
        await delay(this.deps.retryMs ?? 5000);
      }
    }
    return false;
  }
}
