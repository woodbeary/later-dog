import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawnWithSecrets } from "../cloud-home-start.ts";
import { RESTART_EXIT_CODE } from "../restart.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  CRASH_LIMITS, crashDelay, homeServerRestarts, serverExitReport, spokenDuration, stderrTail, superviseHomeServer, type ServerExit,
} from "./home-server-restart.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });

const crash: ServerExit = { code: 1, signal: null };

it("a crash starts the server again after 1, 2, 4, 8 and 16 s, and the sixth crash in ten minutes stops the home", () => {
  let clock = 0;
  const restarts = homeServerRestarts(() => clock);
  const decisions = [1, 2, 3, 4, 5].map(() => {
    const decision = restarts.decide(crash, false);
    clock += decision.delayMs + 5_000;
    return decision;
  });
  expect(decisions.map(({ again, why, delayMs, crashes }) => [again, why, delayMs, crashes])).toEqual([
    [true, "crashed", 1_000, 1], [true, "crashed", 2_000, 2], [true, "crashed", 4_000, 3], [true, "crashed", 8_000, 4], [true, "crashed", 16_000, 5],
  ]);
  expect(restarts.decide({ code: null, signal: "SIGKILL" }, false)).toEqual({ again: false, why: "crashed too often", delayMs: 0, crashes: 5 });
});

it("crashes older than the window stop counting, and the wait never passes its cap", () => {
  let clock = 0;
  const restarts = homeServerRestarts(() => clock);
  for (let run = 0; run < 5; run++) {
    expect(restarts.decide(crash, false).again).toBe(true);
    clock += 1_000;
  }
  expect(restarts.decide(crash, false).again).toBe(false);
  clock = CRASH_LIMITS.windowMs;
  expect(restarts.decide(crash, false)).toEqual({ again: true, why: "crashed", delayMs: 16_000, crashes: 5 });
  expect([1, 2, 5, 6, 10].map((crashes) => crashDelay(crashes))).toEqual([1_000, 2_000, 16_000, 30_000, 30_000]);
  expect(crashDelay(6, { ...CRASH_LIMITS, maxDelayMs: 20_000 })).toBe(20_000);
});

it("any exit but 75 is a crash, even 0 or a signal; 75 starts again at once on its own count; nothing starts while stopping", () => {
  const restarts = homeServerRestarts(() => 0);
  expect(restarts.decide({ code: 0, signal: null }, false)).toMatchObject({ again: true, why: "crashed", crashes: 1 });
  expect(restarts.decide({ code: null, signal: "SIGKILL" }, false)).toMatchObject({ again: true, why: "crashed", crashes: 2 });
  for (let run = 0; run < 5; run++) expect(restarts.decide({ code: RESTART_EXIT_CODE, signal: null }, false)).toEqual({ again: true, why: "asked", delayMs: 0, crashes: 2 });
  expect(restarts.decide({ code: RESTART_EXIT_CODE, signal: null }, false)).toMatchObject({ again: false, why: "asked too often" });
  expect(homeServerRestarts(() => 0).decide(crash, true)).toMatchObject({ again: false, why: "stopping" });
  expect(homeServerRestarts(() => 0).decide({ code: RESTART_EXIT_CODE, signal: null }, true)).toMatchObject({ again: false, why: "stopping" });
});

it("keeps the last stderr lines, joining lines and characters split across chunks, and cuts lines that run long", () => {
  const tail = stderrTail(3, 10);
  tail.push("first\nsec");
  tail.push(Buffer.from("ond\n\nthird\r\n"));
  const snowman = Buffer.from("☃ end");
  tail.push(snowman.subarray(0, 1));
  tail.push(snowman.subarray(1));
  expect(tail.lines()).toEqual(["second", "third", "☃ end"]);
  tail.push(`\n${"x".repeat(25)}\nlast`);
  expect(tail.lines()).toEqual(["☃ end", `${"x".repeat(10)}…`, "last"]);
  tail.push("y".repeat(50));
  tail.push("y".repeat(50));
  expect(tail.lines().at(-1)).toBe(`last${"y".repeat(6)}…`);
});

it("says how the server stopped, how long it ran and what it wrote last", () => {
  const crashed = serverExitReport({ code: 1, signal: null }, 3 * 3_600_000 + 120_000, { again: true, why: "crashed", delayMs: 2_000, crashes: 2 },
    ["Error: boom", "    at run (index.js:1:1)"]);
  expect(crashed).toBe([
    "cloud home: the server stopped unexpectedly (exit code 1, signal none, after 3 h 2 min); starting it again in 2 s (restart 2 of 5 allowed in 10 min)",
    "cloud home: the server's last 2 stderr lines:",
    "  | Error: boom",
    "  |     at run (index.js:1:1)",
  ].join("\n"));
  expect(serverExitReport({ code: null, signal: "SIGKILL" }, 4_000, { again: false, why: "crashed too often", delayMs: 0, crashes: 5 }, [])).toBe([
    "cloud home: the server stopped unexpectedly (exit code none, signal SIGKILL, after 4 s) after 5 restarts in 10 min; stopping the home so it starts fresh",
    "cloud home: the server wrote nothing to stderr before it stopped",
  ].join("\n"));
  expect(serverExitReport({ code: 0, signal: null }, 500, { again: false, why: "stopping", delayMs: 0, crashes: 0 }, ["bye"]))
    .toBe("cloud home: the server stopped (exit code 0, signal none, after 500 ms)");
  expect(serverExitReport({ code: RESTART_EXIT_CODE, signal: null }, 61_000, { again: true, why: "asked", delayMs: 0, crashes: 0 }, ["restoring"]))
    .toBe("cloud home: the server asked to start again (exit code 75, signal none, after 1 min 1 s); starting it now");
  expect([0, 999, 1_000, 59_400, 60_000, 61_000, 3_600_000, 3_660_000].map(spokenDuration))
    .toEqual(["0 ms", "999 ms", "1 s", "59 s", "1 min", "1 min 1 s", "1 h", "1 h 1 min"]);
});

function fakeServer(pid: number | undefined) {
  const stderr = new PassThrough();
  const server = Object.assign(new EventEmitter(), {
    pid, stderr, exitCode: null as number | null, killed: [] as string[],
    kill(signal: string) { server.killed.push(signal); return true; },
  });
  return server;
}

function harness(options: { pid?: (run: number) => number | undefined; onStart?: (server: ReturnType<typeof fakeServer>) => void } = {}) {
  const servers: ReturnType<typeof fakeServer>[] = [];
  const waits: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const logs: string[] = [];
  const echoed: string[] = [];
  let failures = 0;
  let clock = 0;
  const supervision = superviseHomeServer(() => {
    const server = fakeServer(options.pid ? options.pid(servers.length) : servers.length + 1);
    servers.push(server);
    options.onStart?.(server);
    return server as unknown as ChildProcess;
  }, {
    failed: () => { failures++; },
    log: (text) => logs.push(text),
    echo: (chunk) => echoed.push(chunk.toString()),
    now: () => clock,
    later: (run, ms) => {
      const wait = { ms, run, cancelled: false };
      waits.push(wait);
      return () => { wait.cancelled = true; };
    },
  });
  return { supervision, servers, waits, logs, echoed, failures: () => failures, tick: (ms: number) => { clock += ms; } };
}

it("logs a crash with its code, signal and last stderr lines, read to the end after the exit, then starts the server again after the wait", async () => {
  const { supervision, servers, waits, logs, echoed, failures, tick } = harness();
  expect(supervision.child()).toBe(servers[0]);
  servers[0]!.stderr.write("starting\nTypeError: x is not a function\n");
  tick(90_000);
  servers[0]!.emit("exit", 1, null);
  servers[0]!.stderr.end("    at turn (index.js:9:9)\n");
  await vi.waitFor(() => expect(waits).toHaveLength(1));
  expect(supervision.child()).toBeNull();
  expect(waits[0]!.ms).toBe(1_000);
  expect(logs).toEqual([[
    "cloud home: the server stopped unexpectedly (exit code 1, signal none, after 1 min 30 s); starting it again in 1 s (restart 1 of 5 allowed in 10 min)",
    "cloud home: the server's last 3 stderr lines:",
    "  | starting",
    "  | TypeError: x is not a function",
    "  |     at turn (index.js:9:9)",
  ].join("\n")]);
  expect(echoed.join("")).toBe("starting\nTypeError: x is not a function\n    at turn (index.js:9:9)\n");
  waits[0]!.run();
  expect(servers).toHaveLength(2);
  expect(supervision.child()).toBe(servers[1]);
  servers[1]!.emit("exit", RESTART_EXIT_CODE, null);
  servers[1]!.stderr.end();
  await vi.waitFor(() => expect(waits).toHaveLength(2));
  expect(waits[1]!.ms).toBe(0);
  expect(logs[1]).toMatch(/^cloud home: the server asked to start again \(exit code 75/);
  expect(failures()).toBe(0);
});

it("a stop during the wait cancels the restart, and a server that exits while stopping is not a failure", async () => {
  const { supervision, servers, waits, logs, failures } = harness();
  servers[0]!.emit("exit", null, "SIGSEGV");
  servers[0]!.stderr.end();
  await vi.waitFor(() => expect(waits).toHaveLength(1));
  supervision.stop();
  expect(waits[0]!.cancelled).toBe(true);
  waits[0]!.run();
  expect(servers).toHaveLength(1);

  const second = harness();
  second.supervision.stop();
  second.servers[0]!.emit("exit", 0, null);
  second.servers[0]!.stderr.end();
  await vi.waitFor(() => expect(second.logs).toEqual(["cloud home: the server stopped (exit code 0, signal none, after 0 ms)"]));
  expect(second.waits).toHaveLength(0);
  expect(second.failures()).toBe(0);
  expect(failures()).toBe(0);
  expect(logs[0]).toContain("signal SIGSEGV");
});

it("gives up after the sixth crash in ten minutes and hands the stop to the launcher; a server that never spawned counts as a crash", async () => {
  const { servers, waits, logs, failures } = harness({
    pid: (run) => (run === 0 ? undefined : run),
    onStart: (server) => queueMicrotask(() => {
      if (server.pid === undefined) server.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }));
      else server.emit("exit", 1, null);
      server.stderr.end();
    }),
  });
  for (let run = 0; run < 5; run++) {
    await vi.waitFor(() => expect(waits).toHaveLength(run + 1));
    waits[run]!.run();
  }
  await vi.waitFor(() => expect(failures()).toBe(1));
  expect(servers).toHaveLength(6);
  expect(waits.map((wait) => wait.ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(logs[0]).toBe("cloud home: the server process failed: spawn EAGAIN");
  expect(logs.at(-1)).toMatch(/after 5 restarts in 10 min; stopping the home so it starts fresh/);
});

it("a server that cannot be started at all stops the home once the launcher holds its supervisor, instead of throwing in the launcher", async () => {
  const logs: string[] = [];
  let failures = 0;
  const supervision = superviseHomeServer(() => { throw new Error("EPERM"); }, { failed: () => { failures++; }, log: (text) => logs.push(text) });
  expect(supervision.child()).toBeNull();
  expect(failures).toBe(0);
  await Promise.resolve();
  expect(failures).toBe(1);
  expect(logs).toEqual(["cloud home: the server could not be started: EPERM"]);
});

it.skipIf(process.platform === "win32")("a real server that throws is started again in place, and its stack reaches the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-home-restart-"));
  directories.push(dir);
  const script = join(dir, "server.mjs");
  const marker = join(dir, "ran-once");
  writeFileSync(script, `
import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, "1");
  setTimeout(() => { throw new Error("first run fails"); }, 5);
} else {
  process.stderr.write("second run up\\n");
  setInterval(() => {}, 1000);
}
`);
  const logs: string[] = [];
  const echoed: string[] = [];
  let failures = 0;
  const supervision = superviseHomeServer(() => spawnWithSecrets(process.execPath, [script], { PATH: process.env.PATH }, {}, null, "pipe"), {
    failed: () => { failures++; },
    log: (text) => logs.push(text),
    echo: (chunk) => echoed.push(chunk.toString()),
    limits: { ...CRASH_LIMITS, firstDelayMs: 10 },
  });
  await vi.waitFor(() => expect(echoed.join("")).toContain("second run up"), { timeout: 15_000, interval: 50 });
  expect(logs[0]).toMatch(/^cloud home: the server stopped unexpectedly \(exit code 1, signal none, after \d+ ms\); starting it again in 10 ms/);
  expect(logs[0]).toContain("  | Error: first run fails");
  const second = supervision.child()!;
  supervision.stop();
  second.kill("SIGTERM");
  await vi.waitFor(() => expect(logs).toHaveLength(2), { timeout: 5_000, interval: 50 });
  expect(logs[1]).toMatch(/^cloud home: the server stopped \(exit code none, signal SIGTERM, after/);
  expect(failures).toBe(0);
}, 30_000);
