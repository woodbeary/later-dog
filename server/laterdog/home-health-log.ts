import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

export const HOME_HEALTH_REPORT_MS = 5 * 60_000;
export const HOME_MEMORY_CHECK_MS = 10_000;
export const HOME_MEMORY_HIGH_SHARE = 0.75;
export const HOME_MEMORY_SETTLED_SHARE = 0.7;
export const CGROUP_MEMORY_MAX = "/sys/fs/cgroup/memory.max";
export const CGROUP_MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";

export type MemoryLimit = { bytes: number; from: "cgroup" | "machine" };
export type MemoryChange = "crossed" | "settled" | null;
export type CrashOrigin = "uncaughtException" | "unhandledRejection";

export function readSystemFile(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function cgroupBytes(text: string | null | undefined): number | null {
  const value = text?.trim() ?? "";
  if (!/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

export function containerMemoryLimit(read: (path: string) => string | null = readSystemFile, machine: number = totalmem()): MemoryLimit {
  const cgroup = cgroupBytes(read(CGROUP_MEMORY_MAX));
  return cgroup !== null && cgroup <= machine ? { bytes: cgroup, from: "cgroup" } : { bytes: machine, from: "machine" };
}

export function memoryThreshold(limitBytes: number, high = HOME_MEMORY_HIGH_SHARE, settled = HOME_MEMORY_SETTLED_SHARE) {
  let above = false;
  return {
    observe(rss: number): MemoryChange {
      if (!above && rss >= limitBytes * high) {
        above = true;
        return "crossed";
      }
      if (above && rss < limitBytes * settled) {
        above = false;
        return "settled";
      }
      return null;
    },
  };
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => `${Math.round(bytes / MIB)} MB`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

export function memoryReport(usage: NodeJS.MemoryUsage, free: number, limit: MemoryLimit, container: number | null): string {
  const parts = [
    `rss ${mib(usage.rss)} (${percent(usage.rss / limit.bytes)} of ${mib(limit.bytes)} ${limit.from === "cgroup" ? "container limit" : "machine memory"})`,
    `heap ${mib(usage.heapUsed)} of ${mib(usage.heapTotal)}`,
    `external ${mib(usage.external)}`,
    `array buffers ${mib(usage.arrayBuffers)}`,
    `free ${mib(free)}`,
  ];
  if (container !== null) parts.push(`whole container ${mib(container)}`);
  return parts.join(", ");
}

export function crashReport(error: unknown, origin: string, uptimeSeconds: number): string {
  const what = origin === "unhandledRejection" ? "an unhandled promise rejection" : "an uncaught exception";
  const detail = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
  return `cloud home: the server is stopping on ${what} after ${Math.round(uptimeSeconds)} s up: ${detail}`;
}

export type HomeHealthEvents = {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown, origin: CrashOrigin) => void): unknown;
  off(event: "uncaughtExceptionMonitor", listener: (error: unknown, origin: CrashOrigin) => void): unknown;
};

export type HomeHealthOptions = {
  log?: (line: string) => void;
  events?: HomeHealthEvents;
  usage?: () => NodeJS.MemoryUsage;
  rss?: () => number;
  uptime?: () => number;
  free?: () => number;
  machine?: () => number;
  read?: (path: string) => string | null;
  every?: (run: () => void, ms: number) => () => void;
  reportMs?: number;
  checkMs?: number;
};

function unrefInterval(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export function startHomeHealthLog(options: HomeHealthOptions = {}): () => void {
  const log = options.log ?? ((line: string) => console.warn(line));
  const events = options.events ?? process;
  const usage = options.usage ?? (() => process.memoryUsage());
  const rss = options.rss ?? (() => process.memoryUsage.rss());
  const uptime = options.uptime ?? (() => process.uptime());
  const free = options.free ?? freemem;
  const read = options.read ?? readSystemFile;
  const every = options.every ?? unrefInterval;
  const limit = containerMemoryLimit(read, (options.machine ?? totalmem)());
  const threshold = memoryThreshold(limit.bytes);
  const report = () => memoryReport(usage(), free(), limit, cgroupBytes(read(CGROUP_MEMORY_CURRENT)));
  const onCrash = (error: unknown, origin: CrashOrigin) => {
    try {
      log(crashReport(error, origin, uptime()));
      log(`cloud home: memory when it stopped: ${report()}`);
    } catch {
      return;
    }
  };
  events.on("uncaughtExceptionMonitor", onCrash);
  log(`cloud home: memory limit ${mib(limit.bytes)} (${limit.from === "cgroup" ? CGROUP_MEMORY_MAX : "no cgroup limit, the machine's memory"}); ${report()}`);
  const stopReports = every(() => log(`cloud home: memory ${report()}`), options.reportMs ?? HOME_HEALTH_REPORT_MS);
  const stopChecks = every(() => {
    const change = threshold.observe(rss());
    if (change === "crossed") log(`cloud home: memory is high, the server passed ${percent(HOME_MEMORY_HIGH_SHARE)} of ${mib(limit.bytes)}: ${report()}`);
    if (change === "settled") log(`cloud home: memory is back under ${percent(HOME_MEMORY_SETTLED_SHARE)} of ${mib(limit.bytes)}: ${report()}`);
  }, options.checkMs ?? HOME_MEMORY_CHECK_MS);
  return () => {
    events.off("uncaughtExceptionMonitor", onCrash);
    stopReports();
    stopChecks();
  };
}
