import { readFileSync } from "node:fs";
import { isEngineProcess, readProcesses, type ProcessInfo } from "./process-reaper.ts";

export const MEMORY_GUARD_CHECK_MS = 2_000;
export const MEMORY_GUARD_SETTLE_MS = 6_000;
export const MEMORY_GUARD_FLOOR_BYTES = 768 * 1024 * 1024;
export const MEMORY_GUARD_SHARE = 0.07;
const PAGE_BYTES = 4096;

export interface MemoryRoom {
  totalBytes: number;
  availableBytes: number;
}

export interface SizedProcess extends ProcessInfo {
  rssBytes: number;
}

export interface Job {
  root: SizedProcess;
  pids: number[];
  rssBytes: number;
}

export function readMemoryRoom(procDir = "/proc"): MemoryRoom | null {
  try {
    const info = readFileSync(`${procDir}/meminfo`, "utf8");
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
    if (!(total > 0) || !Number.isFinite(available)) return null;
    return { totalBytes: total * 1024, availableBytes: available * 1024 };
  } catch {
    return null;
  }
}

export function lowOnMemory(room: MemoryRoom): boolean {
  return room.availableBytes < Math.max(MEMORY_GUARD_FLOOR_BYTES, room.totalBytes * MEMORY_GUARD_SHARE);
}

export function readSizedProcesses(procDir = "/proc"): SizedProcess[] {
  return readProcesses(procDir).map((proc) => {
    let rssBytes = 0;
    try { rssBytes = Number(readFileSync(`${procDir}/${proc.pid}/statm`, "utf8").split(" ")[1]) * PAGE_BYTES || 0; } catch {}
    return { ...proc, rssBytes };
  });
}

function protectedPids(all: readonly SizedProcess[], self: number): Set<number> {
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  const kept = new Set<number>([1, self]);
  let current = byPid.get(self);
  while (current && current.ppid > 0 && !kept.has(current.ppid)) {
    kept.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return kept;
}

export function dogJobs(all: readonly SizedProcess[], self: number): Job[] {
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  const kept = protectedPids(all, self);
  const stoppable = (proc: SizedProcess | undefined): proc is SizedProcess => Boolean(proc) && !kept.has(proc!.pid) && !isEngineProcess(proc!.argv);
  const startedByDog = (root: SizedProcess) => root.ppid === 1 || (!kept.has(root.ppid) && isEngineProcess(byPid.get(root.ppid)?.argv ?? ""));
  const jobs = new Map<number, Job>();
  for (const proc of all) {
    if (!stoppable(proc)) continue;
    let root = proc;
    for (let parent = byPid.get(root.ppid); stoppable(parent); parent = byPid.get(root.ppid)) root = parent;
    if (!startedByDog(root)) continue;
    const job = jobs.get(root.pid) ?? { root, pids: [], rssBytes: 0 };
    job.pids.push(proc.pid);
    job.rssBytes += proc.rssBytes;
    jobs.set(root.pid, job);
  }
  return [...jobs.values()].sort((a, b) => b.rssBytes - a.rssBytes);
}

const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function stoppedLine(job: Job, room: MemoryRoom): string {
  const command = job.root.argv.replace(/\s+/g, " ").slice(0, 160);
  const others = job.pids.length - 1;
  return `cloud home: memory low (${mib(room.availableBytes)} available of ${mib(room.totalBytes)}); stopped "${command}" (pid ${job.root.pid}${others ? ` and ${others} more` : ""}, ${mib(job.rssBytes)}) so the home keeps answering`;
}

export interface MemoryGuardDeps {
  room?: () => MemoryRoom | null;
  processes?: () => SizedProcess[];
  kill?: (pid: number) => void;
  log?: (line: string) => void;
  self?: number;
  now?: () => number;
}

export function memoryGuard(deps: MemoryGuardDeps = {}) {
  const room = deps.room ?? readMemoryRoom;
  const processes = deps.processes ?? readSizedProcesses;
  const kill = deps.kill ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch {} });
  const log = deps.log ?? ((line: string) => console.warn(line));
  const self = deps.self ?? process.pid;
  const now = deps.now ?? Date.now;
  let quietUntil = 0;
  return {
    check(): Job | null {
      if (now() < quietUntil) return null;
      const current = room();
      if (!current || !lowOnMemory(current)) return null;
      const job = dogJobs(processes(), self)[0];
      if (!job) return null;
      for (const pid of job.pids) kill(pid);
      log(stoppedLine(job, current));
      quietUntil = now() + MEMORY_GUARD_SETTLE_MS;
      return job;
    },
  };
}

export function startMemoryGuard(deps: MemoryGuardDeps = {}, everyMs = MEMORY_GUARD_CHECK_MS): () => void {
  const guard = memoryGuard(deps);
  const timer = setInterval(() => guard.check(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
