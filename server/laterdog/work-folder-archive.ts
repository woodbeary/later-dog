import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  sha256: string;
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
  archive(
    paths: string[],
    bytes?: number,
  ): Promise<{ archived: number; bytes: number; skipped?: ArchiveSkip[] }>;
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
  syncDirectory?(dir: string): Promise<void>;
}

export interface FolderSize {
  files: number;
  bytes: number;
  newestMs: number;
  fingerprint: string;
}

export async function measureFolder(dir: string): Promise<FolderSize> {
  const size: FolderSize = { files: 0, bytes: 0, newestMs: 0, fingerprint: "" };
  const fingerprint = createHash("sha256");
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      size.newestMs = Math.max(size.newestMs, info.mtimeMs);
      fingerprint.update(
        JSON.stringify([
          relative(dir, full),
          info.mode,
          info.ino,
          info.dev,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
          info.isSymbolicLink() ? await readlink(full) : null,
        ]),
      );
      if (info.isDirectory()) await walk(full);
      else {
        if (!info.isFile() && !info.isSymbolicLink())
          throw new Error("unsupported work folder entry");
        size.files += 1;
        if (info.isFile()) size.bytes += info.size;
      }
    }
  };
  await walk(dir);
  size.fingerprint = fingerprint.digest("hex");
  return size;
}

const sameSize = (left: FolderSize, right: FolderSize) =>
  left.files === right.files &&
  left.bytes === right.bytes &&
  left.newestMs === right.newestMs &&
  left.fingerprint === right.fingerprint;
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

function validKey(key: string): boolean {
  const parts = key.split("/");
  return parts.length === 2 && parts.every((part) => ID.test(part));
}

function validRecord(key: string, value: unknown): value is MovedOut {
  if (!validKey(key) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as MovedOut;
  const count = (number: unknown) =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (
    typeof record.stamp !== "string" ||
    !/^[a-z0-9-]{1,80}$/.test(record.stamp) ||
    !count(record.bytes) ||
    !count(record.files) ||
    !count(record.movedAt) ||
    typeof record.cleared !== "boolean" ||
    !Array.isArray(record.parts) ||
    !record.parts.length
  )
    return false;
  const thread = key.split("/")[1]!;
  return record.parts.every(
    (part, index) =>
      part &&
      typeof part === "object" &&
      part.name === `wf-${thread}-${record.stamp}-${String(index + 1).padStart(4, "0")}.tar` &&
      count(part.bytes) &&
      part.bytes > 0 &&
      part.bytes <= PART_BYTES &&
      typeof part.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(part.sha256),
  );
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

class NoRoom extends Error {}
class Woke extends Error {}

export class WorkFolderArchive {
  private records: Record<string, MovedOut> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private turns = new Set<string>();
  private sweeping: Promise<number> | null = null;
  private totals = {
    movedOut: 0,
    movedOutBytes: 0,
    broughtBack: 0,
    broughtBackBytes: 0,
    lastSweepAt: null as number | null,
  };
  private readonly deps: WorkFolderDeps;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(deps: WorkFolderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    if (
      !Number.isSafeInteger(deps.partBytes ?? PART_BYTES) ||
      (deps.partBytes ?? PART_BYTES) < 1 ||
      (deps.partBytes ?? PART_BYTES) > PART_BYTES
    )
      throw new Error("invalid work folder part size");
  }

  private file(): string {
    return join(this.deps.dataDir, WORK_FOLDER_RECORDS);
  }

  private safeDir(dir: string, make = false): void {
    const home = resolve(this.deps.home);
    const path = relative(home, resolve(dir));
    if (
      realpathSync(home) !== home ||
      isAbsolute(path) ||
      path.split(sep).some((part) => part === "..")
    )
      throw new Error("unsafe work folder path");
    let at = home;
    for (const part of path.split(sep).filter(Boolean)) {
      at = join(at, part);
      if (make) {
        try {
          mkdirSync(at, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = lstatSync(at);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("unsafe work folder parent");
    }
  }

  private load(): Record<string, MovedOut> {
    if (this.records) return this.records;
    this.safeDir(this.deps.dataDir);
    let parsed: unknown;
    try {
      const file = this.file();
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("invalid work folder record file");
      parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parsed = {};
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Object.entries(parsed).every(([key, value]) => validRecord(key, value))
    )
      throw new Error("invalid work folder record");
    this.records = Object.assign(Object.create(null) as Record<string, MovedOut>, parsed);
    return this.records;
  }

  private save(): void {
    this.safeDir(this.deps.dataDir);
    writeFileAtomic(this.file(), JSON.stringify(this.load()), { mode: 0o600 });
    const fd = openSync(this.deps.dataDir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
    if (!validKey(key) || !/^[A-Za-z0-9_-]+[.]tar$/.test(name))
      throw new Error("invalid work folder part path");
    return `${WORK_FOLDER_PARTS}/${key.split("/")[0]}/${name}`;
  }

  private locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(key, next);
    return next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
  }

  status() {
    const records = Object.values(this.load());
    return {
      enabled: true,
      out: records.length,
      outBytes: records.reduce((sum, record) => sum + record.bytes, 0),
      ...this.totals,
    };
  }

  movedOut(botId: string, threadId: string): MovedOut | null {
    return this.load()[`${botId}/${threadId}`] ?? null;
  }

  private async archivePart(key: string, name: string, bytes: number): Promise<void> {
    const path = this.partPath(key, name);
    const result = await this.deps.bridge.archive([path], bytes);
    if (result.archived !== 1)
      throw new Error(
        `the archive kept ${name} (${result.skipped?.[0]?.why ?? "no reason given"})`,
      );
  }

  private async tarOut(
    key: string,
    dir: string,
    stamp: string,
    stillQuiet: () => boolean,
  ): Promise<MovedOutPart[] | null> {
    const partBytes = this.deps.partBytes ?? PART_BYTES;
    const folder = join(this.deps.home, WORK_FOLDER_PARTS, key.split("/")[0]!);
    this.safeDir(folder, true);
    this.safeDir(dir);
    const child = spawn(this.deps.tar ?? "tar", ["-cf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let complaint = "";
    child.stderr.on("data", (chunk: Buffer) => {
      complaint = (complaint + chunk.toString()).slice(-400);
    });
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    const ended = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
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
      if (code !== 0)
        throw new Error(
          `tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`,
        );
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
      await rm(join(dir, name), { recursive: true, force: true });
    }
    this.safeDir(dir);
    await writeFile(join(dir, MOVED_OUT_NOTE), movedOutNote(record), { mode: 0o600 });
  }

  private eligible(
    chat: WorkspaceTask,
    limits: WorkFolderLimits,
    live: readonly ProcessInfo[],
  ): boolean {
    if (chat.busy || chat.lastActiveAt === null || chat.lastActiveAt > this.now() - limits.idleMs)
      return false;
    return !hasLiveWork(chat, live);
  }

  private moveOut(chat: WorkspaceTask, key: string, before: FolderSize): Promise<number> {
    return this.locked(key, async () => {
      const records = this.load();
      if (records[key]) return 0;
      this.safeDir(chat.dir);
      const stamp = `${this.now().toString(36)}-${randomUUID()}`;
      const stillQuiet = () => {
        const current = this.deps.chats().find((candidate) => candidate.dir === chat.dir);
        return (
          !this.turns.has(key) &&
          Boolean(current && this.eligible(current, this.deps.limits(), this.deps.live()))
        );
      };
      if (!stillQuiet()) return 0;
      const parts = await this.tarOut(key, chat.dir, stamp, stillQuiet);
      this.safeDir(chat.dir);
      if (!parts || !stillQuiet() || !sameSize(before, await measureFolder(chat.dir))) {
        this.log(
          `laterdog home: left ${key.slice(0, 8)}'s work folder on the disk; the chat woke or the folder changed while it was being stored`,
        );
        return 0;
      }
      const record: MovedOut = {
        stamp,
        parts,
        bytes: before.bytes,
        files: before.files,
        movedAt: this.now(),
        cleared: false,
      };
      records[key] = record;
      this.save();
      await this.clear(chat.dir, record, stillQuiet);
      record.cleared = true;
      this.save();
      this.totals.movedOut += 1;
      this.totals.movedOutBytes += before.bytes;
      return before.bytes;
    });
  }

  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = null;
    });
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
      if (known.has(key)) continue;
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
      if (remaining <= 0 || failures >= 3) break;
      if (!key) continue;
      if (records[key]) continue;
      let size: FolderSize;
      try {
        this.safeDir(chat.dir);
        size = await measureFolder(chat.dir);
      } catch {
        continue;
      }
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
    if (moved)
      this.log(
        `laterdog home: moved ${moved} quiet chat(s)' work folders into storage, freed ${mb(freed)}`,
      );
    return freed;
  }

  private async restorePart(key: string, part: MovedOutPart): Promise<string> {
    const full = join(this.deps.home, this.partPath(key, part.name));
    this.safeDir(dirname(full), true);
    let present = await lstat(full).catch(() => null);
    if (present && !present.isFile()) throw new Error("unsafe work folder part");
    if (present && (present.size !== part.bytes || (await fileHash(full)) !== part.sha256)) {
      this.safeDir(dirname(full));
      await rm(full);
      present = null;
    }
    if (!present) {
      const result = await this.deps.bridge.restoreContaining([part.name]);
      if (result.failed) throw new Error(`${part.name} did not come back from storage`);
    }
    this.safeDir(dirname(full));
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile() || info.size !== part.bytes || (await fileHash(full)) !== part.sha256)
      throw new Error(`${part.name} came back incomplete`);
    return full;
  }

  private async syncDirectory(dir: string): Promise<void> {
    this.safeDir(dir);
    if (this.deps.syncDirectory) return this.deps.syncDirectory(dir);
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
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
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    await this.syncDirectory(dir);
  }

  private async mergeRestored(
    source: string,
    target: string,
    names?: readonly string[],
  ): Promise<void> {
    this.safeDir(source);
    this.safeDir(target);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (names && !names.includes(entry.name)) continue;
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isDirectory()) {
        let made = false;
        try {
          await mkdir(to, { mode: 0o700 });
          made = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        this.safeDir(to);
        await this.mergeRestored(from, to);
        if (made) {
          await chmod(to, (await lstat(from)).mode & 0o777);
          await this.syncDirectory(to);
        }
      } else {
        this.safeDir(target);
        try {
          if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
          else if (entry.isFile()) await link(from, to);
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

  private bringBack(key: string): Promise<boolean> {
    return this.locked(key, async () => {
      const records = this.load();
      const record = records[key];
      if (!record) return false;
      const needed = record.bytes + Math.max(...record.parts.map((part) => part.bytes));
      if (!this.deps.room(needed)) {
        await this.deps.makeRoom?.();
        if (!this.deps.room(needed)) throw new NoRoom();
      }
      const dir = this.dirOf(key);
      const existed = await lstat(dir).catch(() => null);
      this.safeDir(dir, true);
      const scratch = await mkdtemp(join(dirname(dir), `.restoring-${key.split("/")[1]}-`));
      const staging = join(scratch, "files");
      await mkdir(staging, { mode: 0o700 });
      const child = spawn(this.deps.tar ?? "tar", ["-xpf", "-", "-C", staging], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let complaint = "";
      child.stderr.on("data", (chunk: Buffer) => {
        complaint = (complaint + chunk.toString()).slice(-400);
      });
      let spawnError: Error | null = null;
      child.once("error", (error) => {
        spawnError = error;
      });
      const ended = new Promise<number | null>((resolve) =>
        child.once("close", (code) => resolve(code)),
      );
      child.stdin.on("error", () => {});
      const restored: string[] = [];
      try {
        for (const part of record.parts) {
          const full = await this.restorePart(key, part);
          restored.push(full);
          for await (const bytes of createReadStream(full)) {
            await new Promise<void>((resolve, reject) => {
              child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
            });
          }
          this.safeDir(dirname(full));
          await rm(full, { force: true });
        }
        child.stdin.end();
        const code = await ended;
        if (spawnError) throw spawnError;
        if (code !== 0)
          throw new Error(
            `tar stopped with code ${code ?? "none"}: ${complaint.trim().split("\n").at(-1) ?? ""}`,
          );
      } catch (error) {
        child.kill("SIGKILL");
        await ended;
        for (const full of restored) {
          this.safeDir(dirname(full));
          await rm(full, { force: true }).catch(() => {});
        }
        this.safeDir(dirname(scratch));
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      let removedNote = false;
      try {
        await this.syncTree(staging);
        const names = (await readdir(staging)).filter((name) => name !== MOVED_OUT_NOTE);
        await this.mergeRestored(staging, dir, names);
        await this.syncParents(dir);
        const note = join(dir, MOVED_OUT_NOTE);
        if (
          (await lstat(note).catch(() => null))?.isFile() &&
          readFileSync(note, "utf8") === movedOutNote(record)
        ) {
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
          try {
            this.save();
          } catch (saveError) {
            this.log(`laterdog home: could not keep restore record: ${said(saveError)}`);
          }
        }
        if (removedNote) {
          await this.restoreNote(dir, scratch, record).catch((noteError) =>
            this.log(`laterdog home: could not put storage note back: ${said(noteError)}`),
          );
        }
        throw error;
      } finally {
        this.safeDir(dirname(scratch));
        await rm(scratch, { recursive: true, force: true }).catch((error) =>
          this.log(`laterdog home: could not remove restore scratch: ${said(error)}`),
        );
      }
      await rmdir(join(this.deps.home, WORK_FOLDER_PARTS, key.split("/")[0]!)).catch(() => {});
      this.totals.broughtBack += 1;
      this.totals.broughtBackBytes += record.bytes;
      this.log(
        `laterdog home: brought ${key.slice(0, 8)}'s work folder back from storage, ${mb(record.bytes)}`,
      );
      return true;
    });
  }

  async beforeTurn(
    botId: string,
    threadId: string,
    current: () => boolean = () => true,
  ): Promise<boolean> {
    const key = `${botId}/${threadId}`;
    if (!validKey(key)) throw new Error("invalid work folder key");
    this.turns.add(key);
    try {
      await this.locked(key, async () => {});
      let warned = false;
      while (current()) {
        if (!this.load()[key]) return true;
        try {
          await this.bringBack(key);
          return current();
        } catch (error) {
          if (!warned) {
            this.log(
              error instanceof NoRoom
                ? `laterdog home: no room to bring ${key.slice(0, 8)}'s work folder back; making room and keeping the pending turn`
                : `laterdog home: ${key.slice(0, 8)}'s work folder is not back yet (${said(error)}); keeping the pending turn and retrying`,
            );
          }
          warned = true;
          await delay(this.deps.retryMs ?? 5000);
        }
      }
      return false;
    } finally {
      this.turns.delete(key);
    }
  }
}
