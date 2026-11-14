import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { saveSkips } from "./save-skips.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const AWAY_MARKER = ".laterdog-away.json";

export const AWAY_RULES = {
  idleDays: 30,
  pressureIdleDays: 7,
  pressureBelowShare: 0.2,
  pressureUntilShare: 0.3,
  smallestBytes: 1 * MB,
  passBytes: 2 * 1024 * MB,
  routineHorizonMs: DAY_MS,
  computerRunWindowMs: DAY_MS,
} as const;

export type AwayRules = typeof AWAY_RULES;

export interface FolderMeasure {
  bytes: number;
  carriedBytes: number;
  leftOutBytes: number;
  files: number;
  newestAt: number | null;
  away: boolean;
  complete: boolean;
}

export interface ChatState {
  exists: boolean;
  inUse: boolean;
  routineSoon: boolean;
  computerRunRecent: boolean;
  lastUsedAt: number | null;
}

export type AwayVerdict =
  | "moves"
  | "moves-under-pressure"
  | "would-move-under-pressure"
  | "in-use"
  | "routine-soon"
  | "computer-run-recent"
  | "used-recently"
  | "changed-recently"
  | "too-small"
  | "no-chat"
  | "already-away"
  | "not-fully-measured";

export interface PlannedChat {
  botId: string;
  threadId: string;
  bytes: number;
  carriedBytes: number;
  leftOutBytes: number;
  files: number;
  lastUsedAt: number | null;
  newestAt: number | null;
  verdict: AwayVerdict;
}

export interface Disk {
  totalBytes: number;
  freeBytes: number;
}

export interface AwayPlan {
  at: number;
  tookMs: number;
  complete: boolean;
  disk: Disk | null;
  underPressure: boolean;
  rules: AwayRules;
  totals: {
    folders: number;
    bytes: number;
    away: number;
    byTimer: { chats: number; bytes: number };
    byPressure: { chats: number; bytes: number; passes: number };
  };
  projected: { freeBytes: number; freeShare: number } | null;
  chats: PlannedChat[];
}

export function freeShare(disk: Disk): number {
  return disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 1;
}

export function underPressure(disk: Disk | null, rules: AwayRules = AWAY_RULES): boolean {
  return disk !== null && freeShare(disk) < rules.pressureBelowShare;
}

function idleFor(chat: ChatState, folder: FolderMeasure, now: number, days: number): "ok" | "used-recently" | "changed-recently" {
  const cutoff = now - days * DAY_MS;
  if (chat.lastUsedAt === null || chat.lastUsedAt > cutoff) return "used-recently";
  if (folder.newestAt !== null && folder.newestAt > cutoff) return "changed-recently";
  return "ok";
}

export function awayVerdict(chat: ChatState, folder: FolderMeasure, now: number, rules: AwayRules = AWAY_RULES): AwayVerdict {
  if (folder.away) return "already-away";
  if (!chat.exists) return "no-chat";
  if (!folder.complete) return "not-fully-measured";
  if (chat.inUse) return "in-use";
  if (chat.routineSoon) return "routine-soon";
  if (chat.computerRunRecent) return "computer-run-recent";
  if (folder.bytes < rules.smallestBytes) return "too-small";
  if (idleFor(chat, folder, now, rules.idleDays) === "ok") return "moves";
  const pressure = idleFor(chat, folder, now, rules.pressureIdleDays);
  return pressure === "ok" ? "would-move-under-pressure" : pressure;
}

export interface MeasuredChat {
  botId: string;
  threadId: string;
  chat: ChatState;
  folder: FolderMeasure;
}

export function pressureOrder(chats: readonly PlannedChat[]): PlannedChat[] {
  return chats.filter((chat) => chat.verdict === "would-move-under-pressure").sort((a, b) => b.bytes - a.bytes);
}

export function timerOrder(chats: readonly PlannedChat[]): PlannedChat[] {
  return chats.filter((chat) => chat.verdict === "moves").sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}

export function planAway(measured: readonly MeasuredChat[], disk: Disk | null, at: number, tookMs: number, rules: AwayRules = AWAY_RULES): AwayPlan {
  const chats: PlannedChat[] = measured.map(({ botId, threadId, chat, folder }) => ({
    botId, threadId,
    bytes: folder.bytes, carriedBytes: folder.carriedBytes, leftOutBytes: folder.leftOutBytes, files: folder.files,
    lastUsedAt: chat.lastUsedAt, newestAt: folder.newestAt,
    verdict: awayVerdict(chat, folder, at, rules),
  }));
  const byTimer = timerOrder(chats);
  const timerBytes = byTimer.reduce((sum, chat) => sum + chat.bytes, 0);
  let free = (disk?.freeBytes ?? 0) + timerBytes;
  const pressured = underPressure(disk, rules);
  const picked: PlannedChat[] = [];
  if (pressured && disk) {
    for (const chat of pressureOrder(chats)) {
      if (free / disk.totalBytes >= rules.pressureUntilShare) break;
      picked.push(chat);
      free += chat.bytes;
    }
    for (const chat of picked) chat.verdict = "moves-under-pressure";
  }
  const pressureBytes = picked.reduce((sum, chat) => sum + chat.bytes, 0);
  let passes = 0;
  for (let pass = 0; pass < picked.length;) {
    let carried = 0;
    while (pass < picked.length && (carried === 0 || carried + picked[pass]!.bytes <= rules.passBytes)) carried += picked[pass++]!.bytes;
    passes += 1;
  }
  return {
    at, tookMs,
    complete: measured.every(({ folder }) => folder.complete),
    disk, underPressure: pressured, rules,
    totals: {
      folders: chats.length,
      bytes: chats.reduce((sum, chat) => sum + chat.bytes, 0),
      away: chats.filter((chat) => chat.verdict === "already-away").length,
      byTimer: { chats: byTimer.length, bytes: timerBytes },
      byPressure: { chats: picked.length, bytes: pressureBytes, passes },
    },
    projected: disk ? { freeBytes: free, freeShare: disk.totalBytes > 0 ? free / disk.totalBytes : 1 } : null,
    chats,
  };
}

export interface MeasureLimits {
  entries: number;
  yieldEvery: number;
}

const DEFAULT_MEASURE: MeasureLimits = { entries: 400_000, yieldEvery: 500 };
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function measureFolder(dir: string, limits: Partial<MeasureLimits> = {}): Promise<FolderMeasure> {
  const { entries, yieldEvery } = { ...DEFAULT_MEASURE, ...limits };
  const result: FolderMeasure = { bytes: 0, carriedBytes: 0, leftOutBytes: 0, files: 0, newestAt: null, away: false, complete: true };
  let seen = 0;
  const top = await readdir(dir).catch(() => null);
  if (!top) return { ...result, complete: false };
  if (top.length === 1 && top[0] === AWAY_MARKER) return { ...result, away: true };
  const walk = async (at: string, carried: boolean): Promise<void> => {
    const names = await readdir(at).catch(() => null);
    if (!names) { result.complete = false; return; }
    for (const name of names) {
      if (++seen > entries) { result.complete = false; return; }
      if (seen % yieldEvery === 0) await pause();
      const path = join(at, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      const type = info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "file";
      const keeps = carried && !saveSkips(name, type);
      const used = info.blocks * 512;
      result.bytes += used;
      if (type === "dir") { await walk(path, keeps); continue; }
      if (!keeps) { result.leftOutBytes += used; continue; }
      if (type === "file") {
        result.files += 1;
        result.carriedBytes += info.size;
        if (result.newestAt === null || info.mtimeMs > result.newestAt) result.newestAt = info.mtimeMs;
      }
    }
  };
  await walk(dir, true);
  return result;
}

export interface ChatFolder {
  botId: string;
  threadId: string;
  dir: string;
}

export async function chatFolders(tasksDir: string): Promise<ChatFolder[]> {
  const found: ChatFolder[] = [];
  for (const botId of (await readdir(tasksDir).catch(() => [])).sort()) {
    if (!ID.test(botId)) continue;
    const botDir = join(tasksDir, botId);
    const info = await lstat(botDir).catch(() => null);
    if (!info?.isDirectory()) continue;
    for (const threadId of (await readdir(botDir).catch(() => [])).sort()) {
      if (!ID.test(threadId)) continue;
      const dir = join(botDir, threadId);
      const inner = await lstat(dir).catch(() => null);
      if (inner?.isDirectory()) found.push({ botId, threadId, dir });
    }
  }
  return found;
}

export async function recentComputerRunFolders(runsDir: string, botId: string, since: number): Promise<string[]> {
  if (!ID.test(botId)) return [];
  const folders: string[] = [];
  for (const name of await readdir(join(runsDir, botId)).catch(() => [])) {
    if (!/^run-[0-9a-f]{8}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(join(runsDir, botId, name), "utf8")) as { folder?: unknown; startedAt?: unknown };
      if (typeof record.folder === "string" && typeof record.startedAt === "number" && record.startedAt >= since) folders.push(record.folder);
    } catch {}
  }
  return folders;
}

export function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export interface AwayPlannerDeps {
  tasksDir: string;
  runsDir: string;
  chat(botId: string, threadId: string): Omit<ChatState, "computerRunRecent">;
  disk(): Disk | null;
  now?: () => number;
  limits?: Partial<MeasureLimits>;
  rules?: AwayRules;
}

export async function measureAwayPlan(deps: AwayPlannerDeps): Promise<AwayPlan> {
  const now = deps.now ?? Date.now;
  const rules = deps.rules ?? AWAY_RULES;
  const started = now();
  const measured: MeasuredChat[] = [];
  const runs = new Map<string, string[]>();
  for (const folder of await chatFolders(deps.tasksDir)) {
    if (!runs.has(folder.botId)) runs.set(folder.botId, await recentComputerRunFolders(deps.runsDir, folder.botId, started - rules.computerRunWindowMs));
    const computerRunRecent = runs.get(folder.botId)!.some((path) => within(path, folder.dir) || within(folder.dir, path));
    measured.push({ botId: folder.botId, threadId: folder.threadId, chat: { ...deps.chat(folder.botId, folder.threadId), computerRunRecent }, folder: await measureFolder(folder.dir, deps.limits) });
  }
  return planAway(measured, deps.disk(), now(), now() - started, rules);
}

export interface AwayPlanner {
  last(): AwayPlan | null;
  measuring(): boolean;
  measure(): boolean;
  settled(): Promise<AwayPlan | null>;
}

export function createAwayPlanner(deps: AwayPlannerDeps, log: (line: string) => void = () => {}): AwayPlanner {
  let last: AwayPlan | null = null;
  let current: Promise<AwayPlan | null> | null = null;
  return {
    last: () => last,
    measuring: () => current !== null,
    measure() {
      if (current) return false;
      current = measureAwayPlan(deps)
        .then((plan) => (last = plan))
        .catch((error: unknown) => {
          log(`could not measure which chats' files could move: ${error instanceof Error ? error.message : String(error)}`);
          return last;
        })
        .finally(() => { current = null; });
      return true;
    },
    settled: () => current ?? Promise.resolve(last),
  };
}
