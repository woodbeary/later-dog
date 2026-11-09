import { lstatSync, readdirSync, rmdirSync, rmSync, statfsSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { trimThreadLog } from "../thread-log-rotation.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

export const CLOUD_THREAD_LOG_MAX_BYTES = 32 * MB;
export const CLOUD_THREAD_LOG_RETENTION_DAYS = 30;
export const TOOL_RESULT_MAX_AGE_DAYS = 7;
export const IDLE_WORKSPACE_DAYS = 3;
export const LOW_DISK_BYTES = 2 * 1024 * MB;
export const DISK_CHECK_MS = 10 * 60 * 1000;
export const JANITOR_EVERY_MS = 6 * 60 * 60 * 1000;

export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

const GENERATED_DIRS: ReadonlySet<string> = new Set([".open-next"]);
const SCRATCH_PARENT = ".wrangler";
const SCRATCH_CHILD = "tmp";

export function buildOutputProject(buildDir: string): string {
  const parent = dirname(buildDir);
  return basename(buildDir) === SCRATCH_CHILD && basename(parent) === SCRATCH_PARENT ? dirname(parent) : parent;
}

export interface DiskUse {
  totalBytes: number;
  freeBytes: number;
}

export function diskUse(path: string): DiskUse | null {
  try {
    const stats = statfsSync(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

export function isLowDisk(disk: DiskUse | null, floor = LOW_DISK_BYTES): boolean {
  return disk !== null && disk.freeBytes < floor;
}

export function sizeOf(path: string): number {
  let total = 0;
  const walk = (at: string) => {
    let entry;
    try { entry = lstatSync(at); } catch { return; }
    if (entry.isSymbolicLink()) return;
    if (!entry.isDirectory()) { total += entry.blocks * 512; return; }
    let names: string[] = [];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) walk(join(at, name));
  };
  walk(path);
  return total;
}

function filesIn(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function capThreadLogs(dirs: readonly string[], maxBytes: number): number {
  let freed = 0;
  for (const dir of dirs) {
    for (const name of filesIn(dir)) {
      if (!name.endsWith(".ndjson")) continue;
      const file = join(dir, name);
      let before: number;
      try { before = lstatSync(file).size; } catch { continue; }
      if (before <= maxBytes) continue;
      trimThreadLog(file, Math.max(1, Math.floor(maxBytes / 2)));
      try { freed += Math.max(0, before - lstatSync(file).size); } catch {}
    }
  }
  return freed;
}

export function pruneOldFiles(dir: string, maxAgeDays: number, now = Date.now()): number {
  const cutoff = now - maxAgeDays * DAY_MS;
  let freed = 0;
  const walk = (at: string): boolean => {
    let empty = true;
    for (const name of filesIn(at)) {
      const path = join(at, name);
      let entry;
      try { entry = lstatSync(path); } catch { continue; }
      if (entry.isDirectory()) {
        if (walk(path)) {
          try { rmdirSync(path); } catch { empty = false; }
        } else empty = false;
        continue;
      }
      if (entry.mtimeMs >= cutoff) { empty = false; continue; }
      try {
        unlinkSync(path);
        freed += entry.blocks * 512;
      } catch { empty = false; }
    }
    return empty;
  };
  walk(dir);
  return freed;
}

export interface WorkspaceTask {
  dir: string;
  busy: boolean;
  closed: boolean;
  lastActiveAt: number | null;
}

export function workspaceIsIdle(task: WorkspaceTask, now = Date.now(), idleDays = IDLE_WORKSPACE_DAYS): boolean {
  if (task.busy) return false;
  if (task.closed) return true;
  return task.lastActiveAt !== null && task.lastActiveAt < now - idleDays * DAY_MS;
}

export function findBuildOutput(root: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const name of filesIn(at)) {
      if (name === ".git") continue;
      const path = join(at, name);
      let entry;
      try { entry = lstatSync(path); } catch { continue; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (BUILD_OUTPUT_DIRS.has(name) || GENERATED_DIRS.has(name)) { found.push(path); continue; }
      if (name === SCRATCH_PARENT) {
        const scratch = join(path, SCRATCH_CHILD);
        try { if (lstatSync(scratch).isDirectory()) found.push(scratch); } catch {}
        continue;
      }
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

export function clearBuildOutput(tasks: readonly WorkspaceTask[], now = Date.now()): { freed: number; cleared: string[] } {
  let freed = 0;
  const cleared: string[] = [];
  for (const task of tasks) {
    if (!workspaceIsIdle(task, now)) continue;
    for (const path of findBuildOutput(task.dir)) {
      const bytes = sizeOf(path);
      try {
        rmSync(path, { recursive: true, force: true });
        freed += bytes;
        cleared.push(path);
      } catch {}
    }
  }
  return { freed, cleared };
}

export interface JanitorRun {
  at: number;
  reason: "scheduled" | "low-disk" | "startup";
  freedBytes: number;
  steps: Record<string, number>;
  freeBefore: number | null;
  freeAfter: number | null;
  reaped: number;
}

export interface JanitorDeps {
  dataDir: string;
  logDirs: readonly string[];
  logMaxBytes: number | null;
  sweepRetention(): void;
  toolResultsDir: string;
  workspaceTasks(): WorkspaceTask[];
  reap(): number;
  vacuum(): number;
  makeSpace?: () => number;
  now?: () => number;
}

export function runJanitor(deps: JanitorDeps, reason: JanitorRun["reason"]): JanitorRun {
  const now = deps.now?.() ?? Date.now();
  const freeBefore = diskUse(deps.dataDir)?.freeBytes ?? null;
  const steps: Record<string, number> = {};
  const step = (name: string, work: () => number) => {
    try { steps[name] = work(); } catch (error) {
      steps[name] = 0;
      console.warn(`[janitor] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  step("logs", () => (deps.logMaxBytes ? capThreadLogs(deps.logDirs, deps.logMaxBytes) : 0));
  step("oldLogs", () => { deps.sweepRetention(); return 0; });
  step("toolResults", () => pruneOldFiles(deps.toolResultsDir, TOOL_RESULT_MAX_AGE_DAYS, now));
  step("buildOutput", () => clearBuildOutput(deps.workspaceTasks(), now).freed);
  step("database", () => deps.vacuum());
  if (deps.makeSpace && isLowDisk(diskUse(deps.dataDir))) step("space", deps.makeSpace);
  let reaped = 0;
  step("processes", () => { reaped = deps.reap(); return 0; });
  const freeAfter = diskUse(deps.dataDir)?.freeBytes ?? null;
  const freedBytes = Object.values(steps).reduce((sum, bytes) => sum + bytes, 0);
  return { at: now, reason, freedBytes, steps, freeBefore, freeAfter, reaped };
}
