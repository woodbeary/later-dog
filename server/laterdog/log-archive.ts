import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { scanYielding } from "./yielding-scan.ts";

export const LOG_THREAD_ID = /^[\w-]{8,200}$/;
export const threadLogPaths = (id: string) => {
  if (!LOG_THREAD_ID.test(id)) throw new Error("invalid archive thread");
  return [`.laterdog/events/${id}.ndjson`, `.laterdog/native/${id}.ndjson`];
};

export const SESSION_AGE_MS = 72 * 60 * 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_SLUG = /^[A-Za-z0-9-]{1,255}$/;
const PROVIDER_FOLDER = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const CODEX_ROLLOUT = /^rollout-[A-Za-z0-9_.-]{1,80}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const YEAR_DIR = /^\d{4}$/;
const TWO_DIGIT_DIR = /^\d{2}$/;
const PROTECTED_NAME = /^(?:auth|credentials|secrets|tokens?)(?:[.-]|$)/i;
const SESSION_FOLDER_DEPTH = 3;
const SESSION_SCAN_ENTRIES = 50_000;
const MAX_SESSIONS = 200;
const MAX_ARCHIVE_PATHS = 2000;
const LOG_DIRS = [".laterdog/events", ".laterdog/native"] as const;

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

export async function findSessionFiles(root: string, wanted: ReadonlySet<string> | ((id: string) => boolean), entryLimit = SESSION_SCAN_ENTRIES, archiveCodexSessions = false): Promise<SessionFiles> {
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
  const codexHomes = archiveCodexSessions ? [".codex"] : [];
  if (await folder(".laterdog/providers")) {
    for (const entry of await list(".laterdog/providers") ?? []) {
      if (!entry.isDirectory() || !PROVIDER_FOLDER.test(entry.name)) continue;
      const providerPath = `.laterdog/providers/${entry.name}`;
      configs.push(providerPath);
      if (!archiveCodexSessions) continue;
      codexHomes.push(providerPath);
      if (entry.name === "hosted") {
        if (await folder(`${providerPath}/codex`)) codexHomes.push(`${providerPath}/codex`);
      } else if (entry.name === "chatgpt-plan" || entry.name === "company") {
        for (const nested of await list(providerPath) ?? []) {
          if (!nested.isDirectory() || !PROVIDER_FOLDER.test(nested.name)) continue;
          const codexPath = `${providerPath}/${nested.name}/codex`;
          if (await folder(codexPath)) codexHomes.push(codexPath);
        }
      }
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
  const scanCodexYear = async (yearPath: string): Promise<void> => {
    if (!await folder(yearPath)) return;
    for (const month of await list(yearPath) ?? []) {
      if (!month.isDirectory() || !TWO_DIGIT_DIR.test(month.name)) continue;
      const monthPath = `${yearPath}/${month.name}`;
      if (!await folder(monthPath)) continue;
      for (const day of await list(monthPath) ?? []) {
        if (!day.isDirectory() || !TWO_DIGIT_DIR.test(day.name)) continue;
        const dayPath = `${monthPath}/${day.name}`;
        if (!await folder(dayPath)) continue;
        for (const entry of await list(dayPath) ?? []) {
          const match = CODEX_ROLLOUT.exec(entry.name);
          if (!match) continue;
          const id = match[1]!;
          if (!accepts(id)) continue;
          await record(id, `${dayPath}/${entry.name}`);
        }
      }
    }
  };
  for (const codexHome of codexHomes) {
    if (!await folder(codexHome)) continue;
    const sessionsDir = `${codexHome}/sessions`;
    if (await folder(sessionsDir)) {
      for (const year of await list(sessionsDir) ?? []) {
        if (year.isDirectory() && YEAR_DIR.test(year.name)) await scanCodexYear(`${sessionsDir}/${year.name}`);
      }
    }
    const archivedDir = `${codexHome}/archived_sessions`;
    if (await folder(archivedDir)) {
      for (const entry of await list(archivedDir) ?? []) {
        const match = CODEX_ROLLOUT.exec(entry.name);
        if (match) {
          const id = match[1]!;
          if (accepts(id)) await record(id, `${archivedDir}/${entry.name}`);
          continue;
        }
        if (entry.isDirectory() && YEAR_DIR.test(entry.name)) await scanCodexYear(`${archivedDir}/${entry.name}`);
      }
    }
  }
  if (entries > entryLimit) for (const value of found.values()) value.unsafe = true;
  return found;
}

export async function findOrphanLogThreads(root: string, known: ReadonlySet<string>, entryLimit = SESSION_SCAN_ENTRIES): Promise<string[]> {
  const found = new Set<string>();
  let entries = 0;
  for (const dir of LOG_DIRS) {
    const info = await lstat(join(root, dir)).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const listed = await readdir(join(root, dir), { withFileTypes: true }).catch(() => null);
    if (!listed) continue;
    entries += listed.length;
    if (entries > entryLimit) return [];
    for (const entry of listed) {
      if (!entry.name.endsWith(".ndjson") || !entry.isFile() || entry.isSymbolicLink()) continue;
      const id = entry.name.slice(0, -".ndjson".length);
      if (LOG_THREAD_ID.test(id) && !known.has(id)) found.add(id);
    }
  }
  return [...found].sort();
}

export type ArchiveSkip = { path: string; why: string };

export type LogArchiveBridge = {
  archive(paths: string[], bytes?: number): Promise<{ archived: number; bytes: number; skipped?: ArchiveSkip[] }>;
  restore(paths: string[]): Promise<void>;
  restoreSessions(sessions: string[]): Promise<void>;
  pending?(): Promise<string[]>;
  restoreContaining?(needles: string[]): Promise<{ restored: number; failed: number }>;
};

export const ARCHIVE_CALL_MS = 120_000;
export const ARCHIVE_CALL_MS_PER_MB = 2000;
export const ARCHIVE_CALL_MAX_MS = 30 * 60_000;

export function archiveCallMs(bytes = 0): number {
  return Math.min(ARCHIVE_CALL_MAX_MS, ARCHIVE_CALL_MS + Math.ceil(bytes / (1024 * 1024)) * ARCHIVE_CALL_MS_PER_MB);
}

export type LoopbackArchiveBridge = Required<LogArchiveBridge>;

export function logArchiveBridge(url: string, token: string): LoopbackArchiveBridge {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
    throw new Error("archive service must use loopback");
  }
  const call = async (path: string, payload: Record<string, string[]>, timeoutMs = ARCHIVE_CALL_MS) => {
    const response = await fetch(new URL(path, endpoint), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`archive service refused: ${response.status}`);
    return await response.json() as { archived: number; bytes: number; failed?: number; skipped?: ArchiveSkip[] };
  };
  return {
    archive: (paths, bytes) => call("archive", { paths }, archiveCallMs(bytes)),
    async pending() {
      const response = await fetch(new URL("status", endpoint), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ARCHIVE_CALL_MS) });
      if (!response.ok) throw new Error(`archive service refused: ${response.status}`);
      const status = await response.json() as { paths?: unknown };
      return Array.isArray(status.paths) ? status.paths.filter((path): path is string => typeof path === "string") : [];
    },
    async restoreContaining(needles) {
      const result = await call("restore", { contains: needles }, ARCHIVE_CALL_MAX_MS) as unknown as { restored?: number; failed?: number };
      return { restored: result.restored ?? 0, failed: result.failed ?? 0 };
    },
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

export type SweepLimits = {
  ageMs: number;
  sessionAgeMs: number;
  byteLimit: number;
  sessionByteLimit: number;
  threadLimit: number;
  quietMs: number;
};

type Options = {
  root: string;
  bridge: LogArchiveBridge;
  threads(): string[];
  idle(threadId: string): boolean;
  orphanLogs?: boolean;
  archiveCodexSessions?: boolean;
  sessions?(threadId: string): string[];
  outsideSessions?(): string[];
  now?: () => number;
  ageMs?: number;
  sessionAgeMs?: number;
  byteLimit?: number;
  sessionByteLimit?: number;
  threadLimit?: number;
  quietMs?: number;
  sweep?(): Partial<SweepLimits>;
  room?(): boolean;
  retryMs?: number;
  report?(message: string): void;
};

type Budget = { admit(size: number): boolean; left(): number };

function budgetOf(limit: number): Budget {
  let remaining = limit;
  return {
    admit(size) {
      if (size <= remaining) { remaining -= size; return true; }
      if (remaining !== limit) return false;
      remaining = 0;
      return true;
    },
    left: () => remaining,
  };
}

type SkipTally = { add(skipped?: ArchiveSkip[]): void; said(): string };

function skipTally(): SkipTally {
  const counts = new Map<string, number>();
  return {
    add(skipped) { for (const skip of skipped ?? []) counts.set(skip.why, (counts.get(skip.why) ?? 0) + 1); },
    said: () => [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([why, count]) => `${count} ${why}`).join(", "),
  };
}

export const ARCHIVE_BATCH_PATHS = 50;
export const ARCHIVE_BATCH_BYTES = 32 * 1024 * 1024;
export const SWEEP_FAILURES_IN_A_ROW = 3;

export function archiveBatches<T extends { size: number }>(files: readonly T[], maxPaths = ARCHIVE_BATCH_PATHS, maxBytes = ARCHIVE_BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (batch.length && (batch.length >= maxPaths || bytes + file.size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const ARCHIVED_CLAUDE_SESSION = /^(?:\.claude|\.laterdog\/providers\/[A-Za-z0-9_][A-Za-z0-9_-]{0,127})\/projects\/[A-Za-z0-9-]{1,255}\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[.]jsonl$|\/)/;
const ARCHIVED_CODEX_SESSION = /^(?:\.codex|\.laterdog\/providers\/(?:[A-Za-z0-9_][A-Za-z0-9_-]{0,127}|hosted\/codex|(?:chatgpt-plan|company)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\/codex))\/(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions(?:\/\d{4}\/\d{2}\/\d{2})?)\/rollout-[A-Za-z0-9_.-]{1,80}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[.]jsonl$/;

export function archivedSessionOf(path: string): string | null {
  return ARCHIVED_CLAUDE_SESSION.exec(path)?.[1] ?? ARCHIVED_CODEX_SESSION.exec(path)?.[1] ?? null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const span = (ms: number) => (ms >= HOUR_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / MINUTE_MS)} min`);
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

class NoRoom extends Error {}

export class LogArchiveCoordinator {
  private gates = new Map<string, Promise<unknown>>();
  private scanning: Promise<void> | null = null;
  private cursor = 0;
  private orphanLogCursor = "";
  private sessionCursor = "";
  private waiting: string | null = null;
  private touched = new Map<string, number>();
  private limitsSaid = "";
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

  private allSessionsOf(id: string): string[] {
    return [...new Set((this.options.sessions?.(id) ?? []).filter(value => SESSION_ID.test(value)))].sort();
  }

  private sessionsOf(id: string): string[] {
    return this.allSessionsOf(id).slice(0, MAX_SESSIONS);
  }

  private limits(): SweepLimits {
    const live = this.options.sweep?.() ?? {};
    return {
      ageMs: live.ageMs ?? this.options.ageMs ?? 24 * HOUR_MS,
      sessionAgeMs: live.sessionAgeMs ?? this.options.sessionAgeMs ?? SESSION_AGE_MS,
      byteLimit: live.byteLimit ?? this.options.byteLimit ?? 64 * 1024 * 1024,
      sessionByteLimit: live.sessionByteLimit ?? this.options.sessionByteLimit ?? 128 * 1024 * 1024,
      threadLimit: live.threadLimit ?? this.options.threadLimit ?? 100,
      quietMs: live.quietMs ?? this.options.quietMs ?? 0,
    };
  }

  private touch(id: string): void {
    this.touched.set(id, this.now());
  }

  private quiet(id: string, quietMs: number): boolean {
    const at = this.touched.get(id);
    return at !== undefined && this.now() - at < quietMs;
  }

  private sessionFree(session: string, quietMs: number): boolean {
    const outside = this.options.outsideSessions;
    if (outside?.().includes(session)) return false;
    let tracked = false;
    for (const thread of this.options.threads()) {
      if (!this.allSessionsOf(thread).includes(session)) continue;
      tracked = true;
      if (!this.sessionsOf(thread).includes(session) || !this.options.idle(thread) || this.quiet(thread, quietMs)) return false;
    }
    return tracked || Boolean(outside);
  }

  private async roomFor(id: string): Promise<boolean> {
    const room = this.options.room;
    if (!room || room()) return true;
    const pending = await this.options.bridge.pending?.().catch(() => null);
    if (!pending) return true;
    const logs = new Set(threadLogPaths(id));
    const sessions = new Set(this.sessionsOf(id));
    if (!pending.some(path => logs.has(path) || sessions.has(archivedSessionOf(path) ?? ""))) return true;
    await this.scan().catch(() => {});
    return room();
  }

  async beforeTurn(id: string, current: () => boolean): Promise<boolean> {
    let warned = false;
    while (current()) {
      this.touch(id);
      try {
        if (!await this.roomFor(id)) throw new NoRoom();
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
      } catch (error) {
        if (!warned) {
          this.report(error instanceof NoRoom
            ? "no room to bring saved logs back; making room and keeping the pending turn"
            : "saved logs unavailable; keeping the pending turn and retrying");
        }
        warned = true;
        await delay(this.options.retryMs ?? 5000);
      }
    }
    return false;
  }

  read<T>(id: string, action: () => T): Promise<T> {
    this.touch(id);
    return this.gate(id, async () => {
      await this.options.bridge.restore(threadLogPaths(id));
      return action();
    });
  }

  readMany<T>(ids: string[], action: () => T): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    for (const id of ordered) this.touch(id);
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

  private sayLimits(limits: SweepLimits): void {
    if (!this.options.sweep) return;
    const now = `logs idle ${span(limits.ageMs)} and engine sessions idle ${span(limits.sessionAgeMs)}`;
    if (now === this.limitsSaid) return;
    if (this.limitsSaid || limits.ageMs < 24 * HOUR_MS) this.report(`now archiving ${now}`);
    this.limitsSaid = now;
  }

  private async archiveSession(session: string, group: SessionGroup | undefined, budget: Budget, limits: SweepLimits, tally: SkipTally): Promise<"archived" | "kept" | "waiting"> {
    const sessionAge = limits.sessionAgeMs;
    if (!group || group.unsafe || !group.files.length || group.files.length > MAX_ARCHIVE_PATHS) return "kept";
    if (group.files.some(file => this.now() - file.mtimeMs < sessionAge)) return "kept";
    return this.holding([session], async () => {
      if (!this.sessionFree(session, limits.quietMs)) return "kept";
      const current = await Promise.all(group.files.map(file => lstat(join(this.options.root, file.path)).catch(() => null)));
      if (current.some(info => !info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < sessionAge)) return "kept";
      if (!this.sessionFree(session, limits.quietMs)) return "kept";
      if (!budget.admit(current.reduce((sum, info) => sum + (info?.size ?? 0), 0))) return "waiting";
      for (const batch of archiveBatches(group.files)) {
        const result = await this.options.bridge.archive(batch.map(file => file.path), batch.reduce((sum, file) => sum + file.size, 0));
        this.totals.sessionFiles += result.archived;
        this.totals.sessionBytes += result.bytes;
        tally.add(result.skipped);
      }
      return "archived";
    });
  }

  private async sweep(): Promise<void> {
    const { root, bridge, idle, threads } = this.options;
    const limits = this.limits();
    const known = threads();
    const maximum = Math.min(known.length, limits.threadLimit);
    let remaining = limits.byteLimit;
    const sessions = budgetOf(limits.sessionByteLimit);
    const tally = skipTally();
    const failures: string[] = [];
    let failedInARow = 0;
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
    this.sayLimits(limits);
    for (const [id, at] of this.touched) if (this.now() - at >= Math.max(limits.quietMs, HOUR_MS)) this.touched.delete(id);
    const attempt = async (name: string, work: () => Promise<void>) => {
      try {
        await work();
        failedInARow = 0;
      } catch (error) {
        failedInARow += 1;
        failures.push(`${name.slice(0, 8)}: ${said(error)}`);
      }
    };
    const failing = () => failedInARow >= SWEEP_FAILURES_IN_A_ROW;
    const batch = Array.from({ length: maximum }, (_, at) => known[(this.cursor + at) % known.length]);
    const tracked = new Set<string>();
    const busy = new Set<string>();
    await scanYielding(known, (id) => {
      for (const session of this.allSessionsOf(id)) tracked.add(session);
      if (!idle(id)) busy.add(id);
    });
    const held = new Set([...busy].flatMap(id => this.sessionsOf(id)));
    const wanted = new Set(batch.filter(id => !busy.has(id)).flatMap(id => this.sessionsOf(id)).filter(id => !held.has(id)));
    if (this.waiting && tracked.has(this.waiting)) wanted.add(this.waiting);
    const archiveCodexSessions = this.options.archiveCodexSessions ?? false;
    const sessionFiles = await findSessionFiles(root, wanted, SESSION_SCAN_ENTRIES, archiveCodexSessions);
    const orphanFiles = this.options.outsideSessions
      ? await findSessionFiles(root, id => !tracked.has(id), SESSION_SCAN_ENTRIES, archiveCodexSessions)
      : new Map() as SessionFiles;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      await attempt(waiting, async () => {
        const outcome = await this.archiveSession(waiting, sessionFiles.get(waiting) ?? orphanFiles.get(waiting), sessions, limits, tally);
        if (outcome === "waiting") this.waiting = waiting;
      });
    }
    const visit = (id: string) => this.gate(id, async () => {
      if (!idle(id)) return;
      const paths: string[] = [];
      let size = 0;
      for (const path of threadLogPaths(id)) {
        const info = await lstat(join(root, path)).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < limits.ageMs || info.size > remaining) continue;
        remaining -= info.size;
        size += info.size;
        paths.push(path);
      }
      if (paths.length && idle(id)) {
        const result = await bridge.archive(paths, size);
        archived += result.archived;
        bytes += result.bytes;
        this.totals.archivedFiles += result.archived;
        this.totals.archivedBytes += result.bytes;
        tally.add(result.skipped);
      }
      for (const session of this.sessionsOf(id)) {
        if (!wanted.has(session) || session === waiting || sessions.left() <= 0 || !idle(id)) continue;
        const outcome = await this.archiveSession(session, sessionFiles.get(session), sessions, limits, tally);
        if (outcome === "waiting") this.waiting ??= session;
      }
    });
    const resting = (id: string) => !idle(id) || this.quiet(id, limits.quietMs);
    for (let count = 0; count < maximum && (remaining > 0 || sessions.left() > 0) && !failing(); count++) {
      const id = known[this.cursor++ % known.length];
      if (resting(id)) continue;
      await attempt(id, () => visit(id));
    }
    if (this.options.orphanLogs && remaining > 0 && !failing()) {
      const knownSet = new Set(known);
      const orphanLogs = await findOrphanLogThreads(root, knownSet);
      const logStart = orphanLogs.findIndex(id => id > this.orphanLogCursor);
      const orderedLogs = logStart < 0 ? orphanLogs : [...orphanLogs.slice(logStart), ...orphanLogs.slice(0, logStart)];
      let orphanVisited = 0;
      for (const id of orderedLogs) {
        if (orphanVisited >= limits.threadLimit || remaining <= 0 || failing()) break;
        orphanVisited += 1;
        if (resting(id)) continue;
        await attempt(id, () => this.gate(id, async () => {
          if (new Set(threads()).has(id) || !idle(id)) return;
          const paths: string[] = [];
          let size = 0;
          for (const path of threadLogPaths(id)) {
            const info = await lstat(join(root, path)).catch(() => null);
            if (!info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < limits.ageMs || info.size > remaining) continue;
            remaining -= info.size;
            size += info.size;
            paths.push(path);
          }
          if (paths.length && idle(id) && !new Set(threads()).has(id)) {
            const result = await bridge.archive(paths, size);
            archived += result.archived;
            bytes += result.bytes;
            this.totals.archivedFiles += result.archived;
            this.totals.archivedBytes += result.bytes;
            tally.add(result.skipped);
          }
          this.orphanLogCursor = id;
        }));
      }
    }
    const orphans = [...orphanFiles.keys()].sort();
    const start = orphans.findIndex(id => id > this.sessionCursor);
    const ordered = start < 0 ? orphans : [...orphans.slice(start), ...orphans.slice(0, start)];
    for (const session of ordered) {
      if (sessions.left() <= 0 || this.waiting || failing()) break;
      if (session === waiting) continue;
      await attempt(session, async () => {
        const outcome = await this.archiveSession(session, orphanFiles.get(session), sessions, limits, tally);
        if (outcome === "waiting") this.waiting = session;
        else this.sessionCursor = session;
      });
    }
    this.totals.freeAfter = await free();
    const sessionsArchived = this.totals.sessionFiles - sessionsBefore.files;
    const sessionBytes = this.totals.sessionBytes - sessionsBefore.bytes;
    const kept = tally.said();
    if (archived || sessionsArchived || kept || failures.length) {
      this.report(`archived ${archived} logs / ${bytes} bytes and ${sessionsArchived} engine session files / ${sessionBytes} bytes; free disk ${before} -> ${this.totals.freeAfter} bytes${kept ? `; kept ${kept}` : ""}${failures.length ? `; ${failures.length} failed, first ${failures[0]}` : ""}`);
    }
    if (failing()) throw new Error("the archive service keeps failing");
  }
}
