import { closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { capThreadLog } from "../thread-log-rotation.ts";

export const HOME_HEALTH_REPORT_MS = 5 * 60_000;
export const HOME_MEMORY_CHECK_MS = 10_000;
export const HOME_MEMORY_HIGH_SHARE = 0.75;
export const HOME_MEMORY_SETTLED_SHARE = 0.7;
export const CGROUP_MEMORY_MAX = "/sys/fs/cgroup/memory.max";
export const CGROUP_MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";
export const KERNEL_VMSTAT = "/proc/vmstat";
export const HOME_HEALTH_FILE = "home-health.log";
export const HOME_HEALTH_FILE_MAX_BYTES = 256 * 1024;
export const HOME_FATAL_REPORTS_DIR = "fatal-error-reports";
export const HOME_FATAL_REPORTS_KEPT = 3;

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

export function oomKillCount(vmstat: string | null | undefined): number | null {
  const match = /^oom_kill (\d+)$/m.exec(vmstat ?? "");
  return match ? Number(match[1]) : null;
}

export function oomKillsSaid(count: number): string {
  return `the kernel has ended ${count} process${count === 1 ? "" : "es"} for lack of memory since the machine started`;
}

export function containerMemoryLimit(read: (path: string) => string | null = readSystemFile, machine: number = totalmem()): MemoryLimit {
  const cgroup = cgroupBytes(read(CGROUP_MEMORY_MAX));
  return cgroup !== null && cgroup <= machine ? { bytes: cgroup, from: "cgroup" } : { bytes: machine, from: "machine" };
}

export function memoryThreshold(limitBytes: number, high = HOME_MEMORY_HIGH_SHARE, settled = HOME_MEMORY_SETTLED_SHARE) {
  let above = false;
  return {
    observe(bytes: number): MemoryChange {
      if (!above && bytes >= limitBytes * high) {
        above = true;
        return "crossed";
      }
      if (above && bytes < limitBytes * settled) {
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

export function memoryReport(usage: NodeJS.MemoryUsage, free: number, limit: MemoryLimit, container: number | null,
  heapLimit: number | null = null, oomKills: number | null = null): string {
  const parts = [
    `rss ${mib(usage.rss)} (${percent(usage.rss / limit.bytes)} of ${mib(limit.bytes)} ${limit.from === "cgroup" ? "container limit" : "machine memory"})`,
    `heap ${mib(usage.heapUsed)} of ${mib(usage.heapTotal)}${heapLimit ? ` (limit ${mib(heapLimit)})` : ""}`,
    `external ${mib(usage.external)}`,
    `array buffers ${mib(usage.arrayBuffers)}`,
    `free ${mib(free)}`,
  ];
  if (container !== null) parts.push(`whole container ${mib(container)}`);
  if (oomKills) parts.push(oomKillsSaid(oomKills));
  return parts.join(", ");
}

export function crashReport(error: unknown, origin: string, uptimeSeconds: number): string {
  const what = origin === "unhandledRejection" ? "an unhandled promise rejection" : "an uncaught exception";
  const detail = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
  return `cloud home: the server is stopping on ${what} after ${Math.round(uptimeSeconds)} s up: ${detail}`;
}

const APPEND_NEVER_THROUGH_A_LINK = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

export function appendHomeHealthLine(file: string, line: string, at: Date = new Date()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, APPEND_NEVER_THROUGH_A_LINK, 0o600);
    try { writeSync(fd, `${at.toISOString()} ${line}\n`); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

const REPORT_FILE = /^report\..+\.json$/;

export function fatalErrorReportFlags(dir: string): string[] {
  return ["--report-on-fatalerror", "--report-exclude-env", "--report-exclude-network", `--report-directory=${dir}`];
}

export function pruneFatalErrorReports(dir: string, kept = HOME_FATAL_REPORTS_KEPT): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const reports = readdirSync(dir).filter((name) => REPORT_FILE.test(name))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { name } of reports.slice(kept)) rmSync(join(dir, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

export type HomeHealthEvents = {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown, origin: CrashOrigin) => void): unknown;
  off(event: "uncaughtExceptionMonitor", listener: (error: unknown, origin: CrashOrigin) => void): unknown;
};

export type HomeHealthOptions = {
  log?: (line: string) => void;
  file?: string | null;
  fileMaxBytes?: number;
  now?: () => Date;
  events?: HomeHealthEvents;
  usage?: () => NodeJS.MemoryUsage;
  rss?: () => number;
  heapUsed?: () => number;
  heapLimit?: () => number;
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
  const print = options.log ?? ((line: string) => console.warn(line));
  const file = options.file ?? null;
  const now = options.now ?? (() => new Date());
  const log = (line: string) => {
    print(line);
    if (file && appendHomeHealthLine(file, line, now())) capThreadLog(file, options.fileMaxBytes ?? HOME_HEALTH_FILE_MAX_BYTES);
  };
  const events = options.events ?? process;
  const usage = options.usage ?? (() => process.memoryUsage());
  const rss = options.rss ?? (() => process.memoryUsage.rss());
  const heapUsed = options.heapUsed ?? (() => getHeapStatistics().used_heap_size);
  const heapLimit = (options.heapLimit ?? (() => getHeapStatistics().heap_size_limit))();
  const uptime = options.uptime ?? (() => process.uptime());
  const free = options.free ?? freemem;
  const read = options.read ?? readSystemFile;
  const every = options.every ?? unrefInterval;
  const limit = containerMemoryLimit(read, (options.machine ?? totalmem)());
  const threshold = memoryThreshold(limit.bytes);
  const heapThreshold = memoryThreshold(heapLimit);
  const report = () => memoryReport(usage(), free(), limit, cgroupBytes(read(CGROUP_MEMORY_CURRENT)), heapLimit, oomKillCount(read(KERNEL_VMSTAT)));
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
    const heapChange = heapThreshold.observe(heapUsed());
    if (heapChange === "crossed") log(`cloud home: the server's heap is high, past ${percent(HOME_MEMORY_HIGH_SHARE)} of its ${mib(heapLimit)} limit: ${report()}`);
    if (heapChange === "settled") log(`cloud home: the server's heap is back under ${percent(HOME_MEMORY_SETTLED_SHARE)} of its ${mib(heapLimit)} limit: ${report()}`);
  }, options.checkMs ?? HOME_MEMORY_CHECK_MS);
  return () => {
    events.off("uncaughtExceptionMonitor", onCrash);
    stopReports();
    stopChecks();
  };
}
