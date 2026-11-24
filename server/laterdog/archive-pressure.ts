import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DISK_RUNGS, diskRung } from "./disk-ladder.ts";
import type { DiskUse } from "./janitor.ts";

const MB = 1024 ** 2;
const GB = 1024 * MB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ArchiveSweep {
  ageMs: number;
  sessionAgeMs: number;
  byteLimit: number;
  sessionByteLimit: number;
  threadLimit: number;
  quietMs: number;
  everyMs: number;
}

const rungOf = (name: string) => DISK_RUNGS.find((step) => step.name === name)!.rung;

export const CALM_SWEEP: ArchiveSweep = {
  ageMs: 24 * HOUR, sessionAgeMs: 72 * HOUR, byteLimit: 64 * MB, sessionByteLimit: 128 * MB, threadLimit: 100, quietMs: 30 * MINUTE, everyMs: 5 * MINUTE,
};

export const LEAST_IDLE_MS = 30 * MINUTE;

export const PRESSURE_SWEEPS: ReadonlyArray<{ from: number; sweep: ArchiveSweep }> = [
  { from: rungOf("sweep"), sweep: { ageMs: 12 * HOUR, sessionAgeMs: 24 * HOUR, byteLimit: 256 * MB, sessionByteLimit: 512 * MB, threadLimit: 200, quietMs: 30 * MINUTE, everyMs: 5 * MINUTE } },
  { from: rungOf("move"), sweep: { ageMs: 2 * HOUR, sessionAgeMs: 6 * HOUR, byteLimit: 1024 * MB, sessionByteLimit: 1024 * MB, threadLimit: 400, quietMs: 15 * MINUTE, everyMs: 2 * MINUTE } },
  { from: rungOf("refuse"), sweep: { ageMs: HOUR, sessionAgeMs: 2 * HOUR, byteLimit: 2048 * MB, sessionByteLimit: 2048 * MB, threadLimit: 1000, quietMs: 10 * MINUTE, everyMs: MINUTE } },
  { from: rungOf("floor"), sweep: { ageMs: LEAST_IDLE_MS, sessionAgeMs: HOUR, byteLimit: Infinity, sessionByteLimit: Infinity, threadLimit: Infinity, quietMs: 10 * MINUTE, everyMs: 30_000 } },
];

export const PLENTY_FREE_BYTES = 8 * GB;
export const ROOM_KEPT_FREE_BYTES = 256 * MB;

export function pressureRung(disk: DiskUse | null): number {
  return disk && disk.freeBytes >= PLENTY_FREE_BYTES ? 0 : diskRung(disk);
}

export function archiveSweep(disk: DiskUse | null): ArchiveSweep {
  const rung = pressureRung(disk);
  return PRESSURE_SWEEPS.reduce((chosen, step) => (rung >= step.from ? step.sweep : chosen), CALM_SWEEP);
}

export interface WorkFolderSweep {
  idleMs: number;
  byteLimit: number;
  minBytes: number;
  minFiles: number;
}

const DAY = 24 * HOUR;
const WORTH_MOVING = { minBytes: 5 * MB, minFiles: 200 };

export const CALM_WORK_FOLDERS: WorkFolderSweep = { idleMs: 3 * DAY, byteLimit: 256 * MB, ...WORTH_MOVING };

export const PRESSURE_WORK_FOLDERS: ReadonlyArray<{ from: number; sweep: WorkFolderSweep }> = [
  { from: rungOf("sweep"), sweep: { idleMs: DAY, byteLimit: 512 * MB, ...WORTH_MOVING } },
  { from: rungOf("move"), sweep: { idleMs: 6 * HOUR, byteLimit: 1024 * MB, ...WORTH_MOVING } },
  { from: rungOf("refuse"), sweep: { idleMs: HOUR, byteLimit: 2048 * MB, ...WORTH_MOVING } },
  { from: rungOf("floor"), sweep: { idleMs: 15 * MINUTE, byteLimit: Infinity, ...WORTH_MOVING } },
];

export function workFolderSweep(disk: DiskUse | null): WorkFolderSweep {
  const rung = pressureRung(disk);
  return PRESSURE_WORK_FOLDERS.reduce((chosen, step) => (rung >= step.from ? step.sweep : chosen), CALM_WORK_FOLDERS);
}

export function roomFor(disk: DiskUse | null, bytes: number): boolean {
  return !disk || disk.totalBytes <= 0 || disk.freeBytes - bytes >= ROOM_KEPT_FREE_BYTES;
}

export function roomToRestore(disk: DiskUse | null): boolean {
  return roomFor(disk, 0);
}

export const SAVE_COPY_RESERVE_BYTES = 256 * MB;
const DATABASE = /\.(?:sqlite3?|db)$/;

function sizeOrZero(path: string): number {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

export function savesHold(dataDir: string): number {
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return 0; }
  const largest = names.filter((name) => DATABASE.test(name))
    .reduce((most, name) => Math.max(most, sizeOrZero(join(dataDir, name)) + sizeOrZero(join(dataDir, `${name}-wal`))), 0);
  return largest > 0 ? largest + SAVE_COPY_RESERVE_BYTES : 0;
}

export const STEADY_WINDOW_MS = 90_000;

export function steadyDisk(read: () => DiskUse | null, held: () => number = () => 0, options: { windowMs?: number; now?: () => number } = {}): () => DiskUse | null {
  const windowMs = options.windowMs ?? STEADY_WINDOW_MS;
  const now = options.now ?? Date.now;
  let samples: Array<{ at: number; freeBytes: number }> = [];
  return () => {
    const disk = read();
    if (!disk) return null;
    const at = now();
    samples = [...samples.filter((sample) => at - sample.at < windowMs), { at, freeBytes: disk.freeBytes }];
    const settled = samples.reduce((most, sample) => Math.max(most, sample.freeBytes), 0);
    return { totalBytes: disk.totalBytes, freeBytes: Math.max(0, settled - held()) };
  };
}

export const FIRST_SWEEP_MS = MINUTE;
export const SWEEP_CHECK_MS = 15_000;

export interface ArchiveSweepsDeps {
  scan(): Promise<void>;
  disk(): DiskUse | null;
  warn?(line: string): void;
  now?: () => number;
  checkMs?: number;
}

export function startArchiveSweeps(deps: ArchiveSweepsDeps): () => void {
  const now = deps.now ?? Date.now;
  let rested = now() - CALM_SWEEP.everyMs + FIRST_SWEEP_MS;
  let running = false;
  const check = () => {
    if (running || now() - rested < archiveSweep(deps.disk()).everyMs) return;
    running = true;
    void deps.scan().catch(() => deps.warn?.("[log archive] scan deferred")).finally(() => {
      running = false;
      rested = now();
    });
  };
  const timer = setInterval(check, deps.checkMs ?? SWEEP_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
