import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";
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

export const TIDY_QUIET_MS = 15 * 60_000;

export function diskRung(disk: DiskUse | null): number {
  if (!disk || disk.totalBytes <= 0) return 0;
  const share = disk.freeBytes / disk.totalBytes;
  return DISK_RUNGS.reduce((reached, step) => (share < step.freeBelow ? step.rung : reached), 0);
}

export function trackedByGit(path: string): boolean {
  const result = spawnSync("git", ["-C", dirname(path), "ls-files", "-z", "--", basename(path)], { timeout: 10_000, maxBuffer: 4096, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  if (result.error) return true;
  if (result.status === 128 && /not a git repository/i.test(result.stderr)) return false;
  return result.status !== 0 || result.stdout.length > 0;
}

export function chatIsQuiet(chat: WorkspaceTask, now: number): boolean {
  if (chat.busy) return false;
  if (chat.closed) return true;
  return chat.lastActiveAt !== null && chat.lastActiveAt < now - TIDY_QUIET_MS;
}

export interface Tidied {
  freed: number;
  cleared: string[];
  chats: number;
}

export function tidyQuietChats(chats: readonly WorkspaceTask[], live: readonly ProcessInfo[], tracked: (path: string) => boolean, now: number): Tidied {
  let freed = 0;
  const cleared: string[] = [];
  const touched = new Set<string>();
  for (const chat of chats) {
    if (!chatIsQuiet(chat, now)) continue;
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
  return { freed, cleared, chats: touched.size };
}

export interface LadderDeps {
  disk(): DiskUse | null;
  chats(): WorkspaceTask[];
  live(): ProcessInfo[];
  tracked?: (path: string) => boolean;
  sweepTemp(): { removed: string[]; freed: number };
  pruneCaches(): number;
  log(line: string): void;
  now?: () => number;
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
  let lastRung = 0;
  return {
    climb(): LadderRun {
      const disk = deps.disk();
      const rung = diskRung(disk);
      const reached = (step: number) => rung >= step && lastRung < step;
      let freed = 0;
      if (disk && rung >= 1) {
        const tidied = tidyQuietChats(deps.chats(), deps.live(), deps.tracked ?? trackedByGit, deps.now?.() ?? Date.now());
        freed += tidied.freed;
        if (tidied.cleared.length || reached(1)) {
          deps.log(`${diskLine(disk)}; cleared rebuildable output in ${tidied.chats} quiet chat(s), freed ${mb(tidied.freed)}`);
        }
      }
      if (disk && rung >= 2) {
        const temp = deps.sweepTemp();
        const caches = deps.pruneCaches();
        freed += temp.freed + caches;
        if (temp.removed.length || caches > 0 || reached(2)) {
          deps.log(`${diskLine(disk)}; removed ${temp.removed.length} temp item(s) no turn was using and pruned package caches, freed ${mb(temp.freed + caches)}`);
        }
      }
      lastRung = rung;
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
