import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const threadLogPaths = (id: string) => {
  if (!/^[\w-]{8,200}$/.test(id)) throw new Error("invalid archive thread");
  return [`.laterdog/events/${id}.ndjson`, `.laterdog/native/${id}.ndjson`];
};

export const SESSION_AGE_MS = 72 * 60 * 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_SLUG = /^[A-Za-z0-9-]{1,255}$/;
const PROVIDER_FOLDER = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const PROTECTED_NAME = /^(?:auth|credentials|secrets|tokens?)(?:[.-]|$)/i;
const SESSION_FOLDER_DEPTH = 3;
const SESSION_SCAN_ENTRIES = 50_000;
const MAX_SESSIONS = 200;
const MAX_ARCHIVE_PATHS = 2000;

export function claudeSessionIds(cursors: Record<string, unknown> | undefined): string[] {
  const found = new Set<string>();
  for (const value of Object.values(cursors ?? {})) {
    const id = typeof value === "string" ? value : (value as { sessionId?: unknown } | null)?.sessionId;
    if (typeof id === "string" && SESSION_ID.test(id)) found.add(id);
  }
  return [...found].sort();
}

export type CursorOwner = { threadId?: string; resumeCursors?: Record<string, unknown>; tasks: Array<{ threadId: string; resumeCursors?: Record<string, unknown> }> };

export function outsideSessionOwners(bots: CursorOwner[], excludedThread: (threadId: string) => boolean): string[] {
  const found = new Set<string>();
  for (const bot of bots) {
    for (const task of bot.tasks) {
      if (excludedThread(task.threadId)) for (const id of claudeSessionIds(task.resumeCursors)) found.add(id);
    }
    const active = bot.tasks.find(task => task.threadId === bot.threadId);
    const mirrored = new Set(active && !excludedThread(active.threadId) ? claudeSessionIds(active.resumeCursors) : []);
    for (const id of claudeSessionIds(bot.resumeCursors)) if (!mirrored.has(id)) found.add(id);
  }
  return [...found].sort();
}

type SessionFile = { path: string; size: number; mtimeMs: number };
export type SessionFiles = Map<string, { files: SessionFile[]; unsafe: boolean }>;
type SessionGroup = { files: SessionFile[]; unsafe: boolean };

export async function findSessionFiles(root: string, wanted: ReadonlySet<string> | ((id: string) => boolean), entryLimit = SESSION_SCAN_ENTRIES): Promise<SessionFiles> {
  const found: SessionFiles = new Map();
  const accepts = typeof wanted === "function" ? (id: string) => SESSION_ID.test(id) && wanted(id) : (id: string) => wanted.has(id);
  if (typeof wanted !== "function" && !wanted.size) return found;
  let entries = 0;
  const folder = async (path: string) => {
    const info = await lstat(join(root, path)).catch(() => null);
    return Boolean(info?.isDirectory() && !info.isSymbolicLink());
  };
  const list = async (path: string) => {
    const listed = await readdir(join(root, path), { withFileTypes: true }).catch(() => null);
    if (listed) entries += listed.length;
    return entries > entryLimit ? null : listed;
  };
  const session = (id: string) => {
    let value = found.get(id);
    if (!value) found.set(id, value = { files: [], unsafe: false });
    return value;
  };
  const record = async (id: string, path: string) => {
    const info = await lstat(join(root, path)).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) session(id).unsafe = true;
    else session(id).files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  };
  const walk = async (id: string, path: string, depth: number): Promise<void> => {
    const listed = await list(path);
    if (!listed) { session(id).unsafe = true; return; }
    for (const entry of listed) {
      const child = `${path}/${entry.name}`;
      if (!SESSION_NAME.test(entry.name) || PROTECTED_NAME.test(entry.name)) session(id).unsafe = true;
      else if (entry.isFile()) await record(id, child);
      else if (entry.isDirectory() && depth < SESSION_FOLDER_DEPTH) await walk(id, child, depth + 1);
      else session(id).unsafe = true;
    }
  };
  const configs = [".claude"];
  if (await folder(".laterdog/providers")) {
    for (const entry of await list(".laterdog/providers") ?? []) {
      if (entry.isDirectory() && PROVIDER_FOLDER.test(entry.name)) configs.push(`.laterdog/providers/${entry.name}`);
    }
  }
  for (const config of configs) {
    if (!await folder(config) || !await folder(`${config}/projects`)) continue;
    for (const project of await list(`${config}/projects`) ?? []) {
      if (!project.isDirectory() || !PROJECT_SLUG.test(project.name)) continue;
      const base = `${config}/projects/${project.name}`;
      for (const entry of await list(base) ?? []) {
        const transcript = entry.name.endsWith(".jsonl");
        const id = transcript ? entry.name.slice(0, -".jsonl".length) : entry.name;
        if (!accepts(id)) continue;
        if (transcript) await record(id, `${base}/${entry.name}`);
        else if (entry.isDirectory()) await walk(id, `${base}/${entry.name}`, 1);
        else session(id).unsafe = true;
      }
    }
  }
  if (entries > entryLimit) for (const value of found.values()) value.unsafe = true;
  return found;
}

export type LogArchiveBridge = {
  archive(paths: string[]): Promise<{ archived: number; bytes: number }>;
  restore(paths: string[]): Promise<void>;
  restoreSessions(sessions: string[]): Promise<void>;
};

export function logArchiveBridge(url: string, token: string): LogArchiveBridge {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
    throw new Error("archive service must use loopback");
  }
  const call = async (path: string, payload: Record<string, string[]>) => {
    const response = await fetch(new URL(path, endpoint), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`archive service refused: ${response.status}`);
    return await response.json() as { archived: number; bytes: number; failed?: number };
  };
  return {
    archive: paths => call("archive", { paths }),
    async restore(paths) {
      const result = await call("restore-logs", { paths });
      if (result.failed !== 0) throw new Error("saved logs are not restored yet");
    },
    async restoreSessions(sessions) {
      const result = await call("restore-sessions", { sessions });
      if (result.failed !== 0) throw new Error("saved engine sessions are not restored yet");
    },
  };
}

type Options = {
  root: string;
  bridge: LogArchiveBridge;
  threads(): string[];
  idle(threadId: string): boolean;
  sessions?(threadId: string): string[];
  outsideSessions?(): string[];
  now?: () => number;
  ageMs?: number;
  sessionAgeMs?: number;
  byteLimit?: number;
  sessionByteLimit?: number;
  threadLimit?: number;
  retryMs?: number;
  report?(message: string): void;
};

type SessionBudget = { admit(size: number): boolean };

export class LogArchiveCoordinator {
  private gates = new Map<string, Promise<unknown>>();
  private scanning: Promise<void> | null = null;
  private cursor = 0;
  private sessionCursor = "";
  private waiting: string | null = null;
  private totals = { archivedFiles: 0, archivedBytes: 0, sessionFiles: 0, sessionBytes: 0, lastScanAt: null as number | null, freeBefore: null as number | null, freeAfter: null as number | null };
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.report = options.report ?? (() => {});
  }

  private async gate<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.gates.set(id, next);
    try { return await next; }
    finally { if (this.gates.get(id) === next) this.gates.delete(id); }
  }

  private holding<T>(sessions: string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(sessions)].sort().map(session => `session:${session}`);
    const next = (at: number): Promise<T> => at === keys.length ? action() : this.gate(keys[at], () => next(at + 1));
    return next(0);
  }

  private sessionsOf(id: string): string[] {
    return [...new Set((this.options.sessions?.(id) ?? []).filter(value => SESSION_ID.test(value)))].sort().slice(0, MAX_SESSIONS);
  }

  private sessionFree(session: string): boolean {
    const outside = this.options.outsideSessions;
    if (outside?.().includes(session)) return false;
    let tracked = false;
    for (const thread of this.options.threads()) {
      if (!this.sessionsOf(thread).includes(session)) continue;
      tracked = true;
      if (!this.options.idle(thread)) return false;
    }
    return tracked || Boolean(outside);
  }

  async beforeTurn(id: string, current: () => boolean): Promise<boolean> {
    let warned = false;
    while (current()) {
      try {
        return await this.gate(id, async () => {
          if (!current()) return false;
          await this.options.bridge.restore(threadLogPaths(id));
          for (;;) {
            const sessions = this.sessionsOf(id);
            await this.holding(sessions, async () => {
              if (sessions.length) await this.options.bridge.restoreSessions(sessions);
            });
            if (!current()) return false;
            if (this.sessionsOf(id).join() === sessions.join()) return true;
          }
        });
      } catch {
        if (!warned) this.report("saved logs unavailable; keeping the pending turn and retrying");
        warned = true;
        await delay(this.options.retryMs ?? 5000);
      }
    }
    return false;
  }

  read<T>(id: string, action: () => T): Promise<T> {
    return this.gate(id, async () => {
      await this.options.bridge.restore(threadLogPaths(id));
      return action();
    });
  }

  readMany<T>(ids: string[], action: () => T): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const next = (at: number): Promise<T> => at === ordered.length
      ? Promise.resolve(action())
      : this.gate(ordered[at], async () => {
        await this.options.bridge.restore(threadLogPaths(ordered[at]));
        return next(at + 1);
      });
    return next(0);
  }

  status() { return { enabled: true, ...this.totals }; }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.sweep().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async archiveSession(session: string, group: SessionGroup | undefined, budget: SessionBudget): Promise<"archived" | "kept" | "waiting"> {
    const sessionAge = this.options.sessionAgeMs ?? SESSION_AGE_MS;
    if (!group || group.unsafe || !group.files.length || group.files.length > MAX_ARCHIVE_PATHS) return "kept";
    if (group.files.some(file => this.now() - file.mtimeMs < sessionAge)) return "kept";
    return this.holding([session], async () => {
      if (!this.sessionFree(session)) return "kept";
      const current = await Promise.all(group.files.map(file => lstat(join(this.options.root, file.path)).catch(() => null)));
      if (current.some(info => !info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < sessionAge)) return "kept";
      if (!this.sessionFree(session)) return "kept";
      if (!budget.admit(current.reduce((sum, info) => sum + (info?.size ?? 0), 0))) return "waiting";
      const result = await this.options.bridge.archive(group.files.map(file => file.path));
      this.totals.sessionFiles += result.archived;
      this.totals.sessionBytes += result.bytes;
      return "archived";
    });
  }

  private async sweep(): Promise<void> {
    const { root, bridge, idle, threads } = this.options;
    const known = threads();
    const maximum = Math.min(known.length, this.options.threadLimit ?? 100);
    const age = this.options.ageMs ?? 24 * 60 * 60_000;
    let remaining = this.options.byteLimit ?? 64 * 1024 * 1024;
    const sessionLimit = this.options.sessionByteLimit ?? 128 * 1024 * 1024;
    let sessionRemaining = sessionLimit;
    const budget: SessionBudget = {
      admit(size) {
        if (size <= sessionRemaining) { sessionRemaining -= size; return true; }
        if (sessionRemaining !== sessionLimit) return false;
        sessionRemaining = 0;
        return true;
      },
    };
    let archived = 0;
    let bytes = 0;
    const sessionsBefore = { files: this.totals.sessionFiles, bytes: this.totals.sessionBytes };
    const free = async () => {
      const disk = await statfs(root);
      return disk.bavail * disk.bsize;
    };
    const before = await free();
    this.totals.freeBefore = before;
    this.totals.lastScanAt = this.now();
    const batch = Array.from({ length: maximum }, (_, at) => known[(this.cursor + at) % known.length]);
    const tracked = new Set(known.flatMap(id => this.sessionsOf(id)));
    const held = new Set(known.filter(id => !idle(id)).flatMap(id => this.sessionsOf(id)));
    const wanted = new Set(batch.filter(id => idle(id)).flatMap(id => this.sessionsOf(id)).filter(id => !held.has(id)));
    if (this.waiting && tracked.has(this.waiting)) wanted.add(this.waiting);
    const sessionFiles = await findSessionFiles(root, wanted);
    const orphanFiles = this.options.outsideSessions ?await findSessionFiles(root, id => !tracked.has(id)) : new Map() as SessionFiles;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      const outcome = await this.archiveSession(waiting, sessionFiles.get(waiting) ?? orphanFiles.get(waiting), budget);
      if (outcome === "waiting") this.waiting = waiting;
    }
    for (let count = 0; count < maximum && (remaining > 0 || sessionRemaining > 0); count++) {
      const id = known[this.cursor++ % known.length];
      if (!idle(id)) continue;
      await this.gate(id, async () => {
        if (!idle(id)) return;
        const paths: string[] = [];
        for (const path of threadLogPaths(id)) {
          const info = await lstat(join(root, path)).catch(() => null);
          if (!info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < age || info.size > remaining) continue;
          remaining -= info.size;
          paths.push(path);
        }
        if (paths.length && idle(id)) {
          const result = await bridge.archive(paths);
          archived += result.archived;
          bytes += result.bytes;
          this.totals.archivedFiles += result.archived;
          this.totals.archivedBytes += result.bytes;
        }
        for (const session of this.sessionsOf(id)) {
          if (!wanted.has(session) || session === waiting || sessionRemaining <= 0 || !idle(id)) continue;
          const outcome = await this.archiveSession(session, sessionFiles.get(session), budget);
          if (outcome === "waiting") this.waiting ??= session;
        }
      });
    }
    const orphans = [...orphanFiles.keys()].sort();
    const start = orphans.findIndex(id => id > this.sessionCursor);
    const ordered = start < 0 ? orphans : [...orphans.slice(start), ...orphans.slice(0, start)];
    for (const session of ordered) {
      if (sessionRemaining <= 0 || this.waiting) break;
      if (session === waiting) continue;
      const outcome = await this.archiveSession(session, orphanFiles.get(session), budget);
      if (outcome === "waiting") { this.waiting = session; break; }
      this.sessionCursor = session;
    }
    this.totals.freeAfter = await free();
    const sessionsArchived = this.totals.sessionFiles - sessionsBefore.files;
    const sessionBytes = this.totals.sessionBytes - sessionsBefore.bytes;
    if (archived || sessionsArchived) {
      this.report(`archived ${archived} logs / ${bytes} bytes and ${sessionsArchived} engine session files / ${sessionBytes} bytes; free disk ${before} -> ${this.totals.freeAfter} bytes`);
    }
  }
}
