import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  CGROUP_MEMORY_CURRENT, CGROUP_MEMORY_MAX, HOME_HEALTH_FILE, HOME_HEALTH_REPORT_MS, HOME_MEMORY_CHECK_MS, KERNEL_VMSTAT, appendHomeHealthLine, cgroupBytes,
  containerMemoryLimit, crashReport, fatalErrorReportFlags, memoryReport, memoryThreshold, oomKillCount, pruneFatalErrorReports, startHomeHealthLog,
  type HomeHealthEvents, type HomeHealthOptions,
} from "./home-health-log.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });
const directory = () => { const value = mkdtempSync(join(tmpdir(), "laterdog-home-health-")); directories.push(value); return value; };

it("reads the container limit from cgroup v2 memory.max, and falls back to the machine's memory when there is none", () => {
  const files = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;
  expect(cgroupBytes("4294967296\n")).toBe(4 * GB);
  expect(["max\n", "", "  ", "-1", "12abc", "0", null, undefined].map(cgroupBytes)).toEqual(Array(8).fill(null));
  expect(containerMemoryLimit(files({ [CGROUP_MEMORY_MAX]: `${4 * GB}\n` }), 8 * GB)).toEqual({ bytes: 4 * GB, from: "cgroup" });
  expect(containerMemoryLimit(files({ [CGROUP_MEMORY_MAX]: "max\n" }), 8 * GB)).toEqual({ bytes: 8 * GB, from: "machine" });
  expect(containerMemoryLimit(files({}), 8 * GB)).toEqual({ bytes: 8 * GB, from: "machine" });
  expect(containerMemoryLimit(files({ [CGROUP_MEMORY_MAX]: `${16 * GB}` }), 8 * GB)).toEqual({ bytes: 8 * GB, from: "machine" });
});

it("speaks up once when rss crosses 75% of the limit, stays quiet while it stays high, and listens again only under 70%", () => {
  const threshold = memoryThreshold(1000);
  expect([100, 749, 750, 900, 760, 720, 700, 699, 740, 751, 1000].map((rss) => threshold.observe(rss)))
    .toEqual([null, null, "crossed", null, null, null, null, "settled", null, "crossed", null]);
});

it("counts the processes the kernel ended for lack of memory, and names them in a report only once there are some", () => {
  expect(oomKillCount("nr_free_pages 1024\noom_kill 2\nnr_dirty 3\n")).toBe(2);
  expect(oomKillCount("oom_kill 0\n")).toBe(0);
  expect([null, undefined, "", "nr_free_pages 1\n", "oom_kill x\n", "xoom_kill 4\n"].map(oomKillCount)).toEqual(Array(6).fill(null));
  const usage = { rss: 100 * MB, heapTotal: 80 * MB, heapUsed: 60 * MB, external: 10 * MB, arrayBuffers: 2 * MB };
  const machine = { bytes: 12 * GB, from: "machine" } as const;
  expect(memoryReport(usage, 3000 * MB, machine, null)).toBe("rss 100 MB (1% of 12288 MB machine memory), heap 60 MB of 80 MB, external 10 MB, array buffers 2 MB, free 3000 MB");
  expect(memoryReport(usage, 3000 * MB, machine, null, 2240 * MB, 0)).toBe("rss 100 MB (1% of 12288 MB machine memory), heap 60 MB of 80 MB (limit 2240 MB), external 10 MB, array buffers 2 MB, free 3000 MB");
  expect(memoryReport(usage, 3000 * MB, machine, null, 2240 * MB, 1)).toMatch(/free 3000 MB, the kernel has ended 1 process for lack of memory since the machine started$/);
  expect(memoryReport(usage, 3000 * MB, machine, null, null, 3)).toMatch(/, the kernel has ended 3 processes for lack of memory since the machine started$/);
});

function fakeHome(extra: HomeHealthOptions = {}) {
  const timers = new Map<number, () => void>();
  const events = new EventEmitter();
  const logs: string[] = [];
  const state = { rss: 100 * MB, heap: 60 * MB };
  const stop = startHomeHealthLog({
    log: (line) => logs.push(line),
    events: events as unknown as HomeHealthEvents,
    usage: () => ({ rss: state.rss, heapTotal: 80 * MB, heapUsed: state.heap, external: 10 * MB, arrayBuffers: 2 * MB }),
    rss: () => state.rss,
    heapUsed: () => state.heap,
    heapLimit: () => 2048 * MB,
    uptime: () => 125.4,
    free: () => 3000 * MB,
    machine: () => 8 * GB,
    read: (path) => ({ [CGROUP_MEMORY_MAX]: `${4 * GB}\n`, [CGROUP_MEMORY_CURRENT]: `${1500 * MB}\n` } as Record<string, string>)[path] ?? null,
    every: (run, ms) => {
      timers.set(ms, run);
      return () => timers.delete(ms);
    },
    ...extra,
  });
  return { timers, events, logs, state, stop };
}

it("logs the limit at start, a report every five minutes, a line when rss crosses 75% and when it settles, and a crash with its stack", () => {
  const { timers, events, logs, state, stop } = fakeHome();
  expect([...timers.keys()].sort((a, b) => a - b)).toEqual([HOME_MEMORY_CHECK_MS, HOME_HEALTH_REPORT_MS]);
  const quiet = "rss 100 MB (2% of 4096 MB container limit), heap 60 MB of 80 MB (limit 2048 MB), external 10 MB, array buffers 2 MB, free 3000 MB, whole container 1500 MB";
  expect(logs).toEqual([`cloud home: memory limit 4096 MB (${CGROUP_MEMORY_MAX}); ${quiet}`]);
  timers.get(HOME_HEALTH_REPORT_MS)!();
  expect(logs.at(-1)).toBe(`cloud home: memory ${quiet}`);
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(2);
  state.rss = 3100 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs.at(-1)).toBe("cloud home: memory is high, the server passed 75% of 4096 MB: rss 3100 MB (76% of 4096 MB container limit), heap 60 MB of 80 MB (limit 2048 MB), external 10 MB, array buffers 2 MB, free 3000 MB, whole container 1500 MB");
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(3);
  state.rss = 2800 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs.at(-1)).toMatch(/^cloud home: memory is back under 70% of 4096 MB: rss 2800 MB \(68% of 4096 MB container limit\)/);
  const error = new TypeError("x is not a function");
  events.emit("uncaughtExceptionMonitor", error, "unhandledRejection");
  expect(logs.at(-2)).toBe(`cloud home: the server is stopping on an unhandled promise rejection after 125 s up: ${error.stack}`);
  expect(logs.at(-1)).toMatch(/^cloud home: memory when it stopped: rss 2800 MB/);
  stop();
  expect(timers.size).toBe(0);
  expect(events.listenerCount("uncaughtExceptionMonitor")).toBe(0);
  expect(crashReport("plain reason", "uncaughtException", 3.4)).toBe("cloud home: the server is stopping on an uncaught exception after 3 s up: plain reason");
});

it("says when the server's own heap nears the limit that ends it, before it runs out, and again once it has room", () => {
  const { timers, logs, state, stop } = fakeHome();
  state.heap = 1500 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(1);
  state.heap = 1600 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs.at(-1)).toMatch(/^cloud home: the server's heap is high, past 75% of its 2048 MB limit: rss 100 MB .*, heap 1600 MB of 80 MB \(limit 2048 MB\)/);
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(2);
  state.heap = 1400 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs.at(-1)).toMatch(/^cloud home: the server's heap is back under 70% of its 2048 MB limit: /);
  stop();
});

it("keeps every line in a timestamped file in the data folder, only the owner can read it, and it never grows past its cap", () => {
  const file = join(directory(), "data", HOME_HEALTH_FILE);
  const { timers, events, logs, stop } = fakeHome({ file, fileMaxBytes: 8000, now: () => new Date("2026-10-31T19:56:05.000Z") });
  expect(readFileSync(file, "utf8")).toBe(`2026-10-31T19:56:05.000Z ${logs[0]}\n`);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  for (let report = 0; report < 60; report += 1) timers.get(HOME_HEALTH_REPORT_MS)!();
  events.emit("uncaughtExceptionMonitor", new Error("lost promise"), "unhandledRejection");
  const kept = readFileSync(file, "utf8");
  expect(kept.length).toBeLessThanOrEqual(8000);
  expect(kept).not.toContain("cloud home: memory limit");
  expect(kept).toMatch(/^2026-10-31T19:56:05\.000Z cloud home: memory rss 100 MB/);
  expect(kept.endsWith(`2026-10-31T19:56:05.000Z ${logs.at(-1)}\n`)).toBe(true);
  expect(kept).toContain("\n2026-10-31T19:56:05.000Z cloud home: the server is stopping on an unhandled promise rejection after 125 s up: Error: lost promise\n    at ");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(logs).toHaveLength(63);
  stop();
});

it.skipIf(process.platform === "win32")("never writes the health log through a link someone left in its place", () => {
  const dir = directory();
  const elsewhere = join(dir, "elsewhere.txt");
  writeFileSync(elsewhere, "untouched\n");
  symlinkSync(elsewhere, join(dir, HOME_HEALTH_FILE));
  expect(appendHomeHealthLine(join(dir, HOME_HEALTH_FILE), "cloud home: probe")).toBe(false);
  expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
  expect(appendHomeHealthLine(join(dir, "fresh", HOME_HEALTH_FILE), "cloud home: probe", new Date("2026-10-31T20:00:00.000Z"))).toBe(true);
  expect(readFileSync(join(dir, "fresh", HOME_HEALTH_FILE), "utf8")).toBe("2026-10-31T20:00:00.000Z cloud home: probe\n");
});

it("keeps only the newest three fatal-error reports, in a folder only the owner can open, and asks Node for them without the environment", () => {
  const dir = join(directory(), "reports");
  expect(pruneFatalErrorReports(dir)).toBe(true);
  if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  const names = ["report.20261029.010101.11.0.001.json", "report.20261030.010101.12.0.001.json", "report.20261031.010101.13.0.001.json",
    "report.20261031.195608.24.0.001.json", "report.20261028.010101.10.0.001.json"];
  names.forEach((name, index) => {
    writeFileSync(join(dir, name), "{}");
    const at = new Date(Date.UTC(2026, 9, [29, 30, 31, 31, 28][index], index === 3 ? 19 : 1));
    utimesSync(join(dir, name), at, at);
  });
  writeFileSync(join(dir, "notes.txt"), "kept");
  expect(pruneFatalErrorReports(dir)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(["notes.txt", names[1], names[2], names[3]].sort());
  expect(pruneFatalErrorReports(join(dir, "notes.txt", "reports"))).toBe(false);
  expect(fatalErrorReportFlags("/data/.laterdog/fatal-error-reports"))
    .toEqual(["--report-on-fatalerror", "--report-exclude-env", "--report-exclude-network", "--report-directory=/data/.laterdog/fatal-error-reports"]);
});

it("a real server still exits on an unhandled rejection after logging its stack to the console and its health log, and the timers never keep a quiet server alive", () => {
  const file = join(directory(), HOME_HEALTH_FILE);
  const module = JSON.stringify(join(import.meta.dirname, "home-health-log.ts"));
  const run = (body: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `const { startHomeHealthLog } = await import(${module}); startHomeHealthLog({ file: ${JSON.stringify(file)} }); ${body}`],
    { encoding: "utf8", timeout: 20_000 });
  const crashed = run(`Promise.reject(new Error("lost promise"));`);
  expect(crashed.status).toBe(1);
  expect(crashed.stderr).toMatch(/cloud home: memory limit \d+ MB/);
  expect(crashed.stderr).toMatch(/cloud home: the server is stopping on an unhandled promise rejection after \d+ s up: Error: lost promise\n\s+at /);
  expect(crashed.stderr).toMatch(/cloud home: memory when it stopped: rss \d+ MB/);
  const saved = readFileSync(file, "utf8");
  expect(saved).toMatch(/^\S+Z cloud home: memory limit \d+ MB .*heap \d+ MB of \d+ MB \(limit \d+ MB\)/);
  expect(saved).toMatch(/\n\S+Z cloud home: the server is stopping on an unhandled promise rejection after \d+ s up: Error: lost promise\n\s+at /);
  expect(saved).toMatch(/\n\S+Z cloud home: memory when it stopped: rss \d+ MB.*\n$/);
  const quiet = run("");
  expect(quiet.status).toBe(0);
  expect(quiet.stderr).toMatch(/cloud home: memory limit \d+ MB/);
});

it.skipIf(process.platform !== "linux")("a server started with those flags that runs out of heap leaves a report saying so, with no environment or network details in it", () => {
  const dir = directory();
  const reports = join(dir, "reports");
  expect(pruneFatalErrorReports(reports)).toBe(true);
  const script = `const kept = []; for (;;) kept.push(Array.from({ length: 10_000 }, (_, index) => ({ index, text: "x" + index })));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", ...fatalErrorReportFlags(reports), "-e", script],
    { cwd: dir, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, LATERDOG_PROBE_SECRET: "probe-value-never-in-a-report" } });
  expect(result.signal).toBe("SIGABRT");
  expect(result.stderr).toMatch(/JavaScript heap out of memory/);
  const written = readdirSync(reports).filter((name) => /^report\..+\.json$/.test(name));
  expect(written).toHaveLength(1);
  const text = readFileSync(join(reports, written[0]!), "utf8");
  const report = JSON.parse(text) as { header: { event: string; trigger: string; networkInterfaces?: unknown }; javascriptHeap: unknown; environmentVariables?: unknown };
  expect(report.header.event).toMatch(/heap out of memory/i);
  expect(report.header.trigger).toBe("OOMError");
  expect(report.javascriptHeap).toBeDefined();
  expect(report.environmentVariables).toBeUndefined();
  expect(report.header.networkInterfaces).toBeUndefined();
  expect(text).not.toContain("probe-value-never-in-a-report");
});

it("reads the kernel's out-of-memory count from where Linux keeps it", () => {
  expect(KERNEL_VMSTAT).toBe("/proc/vmstat");
  const { logs, stop } = fakeHome({ read: (path) => (path === KERNEL_VMSTAT ? "oom_kill 4\n" : null) });
  expect(logs[0]).toMatch(/, the kernel has ended 4 processes for lack of memory since the machine started$/);
  stop();
});
