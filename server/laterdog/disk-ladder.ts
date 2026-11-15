import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { DISK_CHECK_MS, findBuildOutput, sizeOf, type DiskUse, type WorkspaceTask } from "./janitor.ts";
import type { ProcessInfo } from "./process-reaper.ts";
import { inUse } from "./space-maker.ts";

export const DISK_RUNGS = [
  { rung: 1, name: "tidy", freeBelow: 0.35 },
  { rung: 2, name: "sweep", freeBelow: 0.25 },
  { rung: 3, name: "move", freeBelow: 0.15 },
  { rung: 4, name: "refuse", freeBelow: 0.10 },
  { rung: 5, name: "floor", freeBelow: 0.05 },
] as const;

const DAY_MS = 24 * 60 * 60_000;
export const TIDY_IDLE_MS = DAY_MS;
export const STORE_PRUNE_EVERY_MS = DAY_MS;
export const TIDY_HEADROOM = 0.05;

export function diskRung(disk: DiskUse | null): number {
  if (!disk || disk.totalBytes <= 0) return 0;
  const share = disk.freeBytes / disk.totalBytes;
  return DISK_RUNGS.reduce((reached, step) => (share < step.freeBelow ? step.rung : reached), 0);
}

export function tidiedEnough(disk: DiskUse | null): boolean {
  return !disk || disk.totalBytes <= 0 || disk.freeBytes / disk.totalBytes >= DISK_RUNGS[0].freeBelow + TIDY_HEADROOM;
}

export function trackedByGit(path: string): boolean {
  const result = spawnSync("git", ["-C", dirname(path), "ls-files", "-z", "--", basename(path)], { timeout: 10_000, maxBuffer: 4096, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  if (result.error) return true;
  if (result.status === 128 && /not a git repository/i.test(result.stderr)) return false;
  return result.status !== 0 || result.stdout.length > 0;
}

export function chatIsIdle(chat: WorkspaceTask, now: number): boolean {
  if (chat.busy) return false;
  if (chat.lastActiveAt === null) return chat.closed;
  return chat.lastActiveAt <= now - TIDY_IDLE_MS;
}

export interface LadderMemory {
  cleared: Record<string, number>;
  prunedAt: number | null;
}

export interface LadderStore {
  load(): LadderMemory;
  save(memory: LadderMemory): void;
}

export function clearedSinceLastTurn(chat: WorkspaceTask, memory: LadderMemory): boolean {
  const at = memory.cleared[chat.dir];
  return at !== undefined && (chat.lastActiveAt ?? 0) <= at;
}

export function tidyOrder(chats: readonly WorkspaceTask[], memory: LadderMemory, now: number): WorkspaceTask[] {
  return chats
    .filter((chat) => chatIsIdle(chat, now) && !clearedSinceLastTurn(chat, memory))
    .sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
}

export interface Tidied {
  freed: number;
  cleared: string[];
  chats: number;
  visited: string[];
}

export function tidyIdleChats(chats: readonly WorkspaceTask[], live: readonly ProcessInfo[], tracked: (path: string) => boolean, enough: () => boolean = () => false): Tidied {
  let freed = 0;
  const cleared: string[] = [];
  const visited: string[] = [];
  const touched = new Set<string>();
  for (const chat of chats) {
    if (enough()) break;
    visited.push(chat.dir);
    for (const path of findBuildOutput(chat.dir)) {
      if (inUse(path, [], live) || tracked(path)) continue;
      const bytes = sizeOf(path);
      try {
        rmSync(path, { recursive: true, force: true });
        freed += bytes;
        cleared.push(path);
        touched.add(chat.dir);
      } catch {}
    }
  }
  return { freed, cleared, chats: touched.size, visited };
}

export function memoryStore(): LadderStore {
  let memory: LadderMemory = { cleared: {}, prunedAt: null };
  return { load: () => memory, save: (next) => { memory = next; } };
}

export function fileLadderStore(file: string): LadderStore {
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(file, "utf8")) as Partial<LadderMemory>;
        const cleared = value.cleared && typeof value.cleared === "object" && !Array.isArray(value.cleared) ? value.cleared : {};
        return { cleared: { ...cleared }, prunedAt: typeof value.prunedAt === "number" ? value.prunedAt : null };
      } catch {
        return { cleared: {}, prunedAt: null };
      }
    },
    save(memory) {
      try { writeFileAtomic(file, JSON.stringify(memory), { mode: 0o600 }); } catch {}
    },
  };
}

export interface LadderDeps {
  disk(): DiskUse | null;
  chats(): WorkspaceTask[];
  live(): ProcessInfo[];
  tracked?: (path: string) => boolean;
  sweepTemp(): { removed: string[]; freed: number };
  pruneCaches(): number | null;
  log(line: string): void;
  now?: () => number;
  store?: LadderStore;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

export function diskLine(disk: DiskUse): string {
  return `laterdog home: disk ${Math.round((disk.freeBytes / disk.totalBytes) * 100)}% free (${gb(disk.freeBytes)} of ${gb(disk.totalBytes)})`;
}

export interface LadderRun {
  rung: number;
  freed: number;
}

export function diskLadder(deps: LadderDeps) {
  const store = deps.store ?? memoryStore();
  return {
    climb(): LadderRun {
      const disk = deps.disk();
      const rung = diskRung(disk);
      if (!disk || rung < 1) return { rung, freed: 0 };
      const now = deps.now?.() ?? Date.now();
      const chats = deps.chats();
      const before = store.load();
      const known = new Set(chats.map((chat) => chat.dir));
      const memory: LadderMemory = { cleared: Object.fromEntries(Object.entries(before.cleared).filter(([dir]) => known.has(dir))), prunedAt: before.prunedAt };
      const order = tidyOrder(chats, memory, now);
      const tidied = order.length ? tidyIdleChats(order, deps.live(), deps.tracked ?? trackedByGit, () => tidiedEnough(deps.disk())) : { freed: 0, cleared: [], chats: 0, visited: [] };
      for (const dir of tidied.visited) memory.cleared[dir] = now;
      let temp = { removed: [] as string[], freed: 0 };
      let caches = 0;
      let pruned = false;
      if (rung >= 2) {
        temp = deps.sweepTemp();
        if (memory.prunedAt === null || now - memory.prunedAt > STORE_PRUNE_EVERY_MS) {
          const freedByPrune = deps.pruneCaches();
          if (freedByPrune !== null) {
            caches = freedByPrune;
            memory.prunedAt = now;
            pruned = true;
          }
        }
      }
      if (tidied.visited.length || pruned || Object.keys(memory.cleared).length !== Object.keys(before.cleared).length) store.save(memory);
      const freed = tidied.freed + temp.freed + caches;
      if (tidied.cleared.length || temp.removed.length || caches > 0) {
        deps.log(`${diskLine(disk)}; cleared rebuildable output in ${tidied.chats} chat(s), removed ${temp.removed.length} temp item(s)${caches > 0 ? " and pruned package caches" : ""}, freed ${mb(freed)}`);
      }
      return { rung, freed };
    },
  };
}

export function startDiskLadder(deps: LadderDeps, everyMs = DISK_CHECK_MS): () => void {
  const ladder = diskLadder(deps);
  let climbing = false;
  const timer = setInterval(() => {
    if (climbing) return;
    climbing = true;
    try { ladder.climb(); } catch (error) {
      console.warn(`laterdog home: disk upkeep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      climbing = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
