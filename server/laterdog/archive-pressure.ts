import { DISK_RUNGS, diskRung, emergencyBelowBytes } from "./disk-ladder.ts";
import type { DiskUse } from "./janitor.ts";

const MB = 1024 ** 2;
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

export const PRESSURE_SWEEPS: ReadonlyArray<{ from: number; sweep: ArchiveSweep }> = [
  { from: rungOf("sweep"), sweep: { ageMs: 12 * HOUR, sessionAgeMs: 24 * HOUR, byteLimit: 256 * MB, sessionByteLimit: 512 * MB, threadLimit: 200, quietMs: 30 * MINUTE, everyMs: 5 * MINUTE } },
  { from: rungOf("move"), sweep: { ageMs: 2 * HOUR, sessionAgeMs: 6 * HOUR, byteLimit: 1024 * MB, sessionByteLimit: 1024 * MB, threadLimit: 400, quietMs: 15 * MINUTE, everyMs: 2 * MINUTE } },
  { from: rungOf("refuse"), sweep: { ageMs: 30 * MINUTE, sessionAgeMs: HOUR, byteLimit: 2048 * MB, sessionByteLimit: 2048 * MB, threadLimit: 1000, quietMs: 10 * MINUTE, everyMs: MINUTE } },
  { from: rungOf("floor"), sweep: { ageMs: 0, sessionAgeMs: 0, byteLimit: Infinity, sessionByteLimit: Infinity, threadLimit: Infinity, quietMs: 2 * MINUTE, everyMs: 30_000 } },
];

export function archiveSweep(disk: DiskUse | null): ArchiveSweep {
  const rung = diskRung(disk);
  return PRESSURE_SWEEPS.reduce((chosen, step) => (rung >= step.from ? step.sweep : chosen), CALM_SWEEP);
}

export function roomToRestore(disk: DiskUse | null): boolean {
  return !disk || disk.totalBytes <= 0 || disk.freeBytes >= emergencyBelowBytes(disk);
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
