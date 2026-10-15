import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  CGROUP_MEMORY_CURRENT, CGROUP_MEMORY_MAX, HOME_HEALTH_REPORT_MS, HOME_MEMORY_CHECK_MS, cgroupBytes, containerMemoryLimit, crashReport, memoryThreshold,
  startHomeHealthLog, type HomeHealthEvents,
} from "./home-health-log.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

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

it("logs the limit at start, a report every five minutes, a line when rss crosses 75% and when it settles, and a crash with its stack", () => {
  const timers = new Map<number, () => void>();
  const events = new EventEmitter();
  const logs: string[] = [];
  let rss = 100 * MB;
  const stop = startHomeHealthLog({
    log: (line) => logs.push(line),
    events: events as unknown as HomeHealthEvents,
    usage: () => ({ rss, heapTotal: 80 * MB, heapUsed: 60 * MB, external: 10 * MB, arrayBuffers: 2 * MB }),
    rss: () => rss,
    uptime: () => 125.4,
    free: () => 3000 * MB,
    machine: () => 8 * GB,
    read: (path) => ({ [CGROUP_MEMORY_MAX]: `${4 * GB}\n`, [CGROUP_MEMORY_CURRENT]: `${1500 * MB}\n` } as Record<string, string>)[path] ?? null,
    every: (run, ms) => {
      timers.set(ms, run);
      return () => timers.delete(ms);
    },
  });
  expect([...timers.keys()].sort((a, b) => a - b)).toEqual([HOME_MEMORY_CHECK_MS, HOME_HEALTH_REPORT_MS]);
  const quiet = "rss 100 MB (2% of 4096 MB container limit), heap 60 MB of 80 MB, external 10 MB, array buffers 2 MB, free 3000 MB, whole container 1500 MB";
  expect(logs).toEqual([`cloud home: memory limit 4096 MB (${CGROUP_MEMORY_MAX}); ${quiet}`]);
  timers.get(HOME_HEALTH_REPORT_MS)!();
  expect(logs.at(-1)).toBe(`cloud home: memory ${quiet}`);
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(2);
  rss = 3100 * MB;
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs.at(-1)).toBe("cloud home: memory is high, the server passed 75% of 4096 MB: rss 3100 MB (76% of 4096 MB container limit), heap 60 MB of 80 MB, external 10 MB, array buffers 2 MB, free 3000 MB, whole container 1500 MB");
  timers.get(HOME_MEMORY_CHECK_MS)!();
  expect(logs).toHaveLength(3);
  rss = 2800 * MB;
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

it("a real server still exits on an unhandled rejection after logging its stack, and the timers never keep a quiet server alive", () => {
  const module = JSON.stringify(join(import.meta.dirname, "home-health-log.ts"));
  const run = (body: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `const { startHomeHealthLog } = await import(${module}); startHomeHealthLog(); ${body}`],
    { encoding: "utf8", timeout: 20_000 });
  const crashed = run(`Promise.reject(new Error("lost promise"));`);
  expect(crashed.status).toBe(1);
  expect(crashed.stderr).toMatch(/cloud home: memory limit \d+ MB/);
  expect(crashed.stderr).toMatch(/cloud home: the server is stopping on an unhandled promise rejection after \d+ s up: Error: lost promise\n\s+at /);
  expect(crashed.stderr).toMatch(/cloud home: memory when it stopped: rss \d+ MB/);
  const quiet = run("");
  expect(quiet.status).toBe(0);
  expect(quiet.stderr).toMatch(/cloud home: memory limit \d+ MB/);
});
