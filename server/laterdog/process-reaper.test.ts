import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEngineProcess, orphanIdleHours, PRESSURE_ORPHAN_MINUTES, readMemoryPressure, reapReason, reapStrays, underMemoryPressure, withDescendants, workspaceThread, type ProcessInfo, type ThreadState } from "./process-reaper.ts";

const ROOT = "/data/.laterdog/task-workspaces";
const HOUR = 60 * 60 * 1000;
const now = 1_000 * HOUR;
const at = (bot: string, thread: string, sub = "") => `${ROOT}/${bot}/${thread}${sub}`;
const live: ThreadState = { exists: true, busy: false, closed: false, lastActiveAt: now - HOUR };

describe("which processes belong to a task", () => {
  it("reads the dog and task from the working folder", () => {
    expect(workspaceThread(at("dog", "t1", "/portfolio"), [ROOT])).toEqual({ botId: "dog", threadId: "t1" });
    expect(workspaceThread(`${ROOT}/dog`, [ROOT])).toBeNull();
    expect(workspaceThread("/data/.laterdog/workspaces/dog/notes", [ROOT])).toBeNull();
    expect(workspaceThread("/tmp", [ROOT])).toBeNull();
  });

  it("never treats the dog's own engine or its helpers as strays", () => {
    for (const argv of [
      "/usr/local/bin/claude --resume abc",
      "/usr/local/bin/node /tmp/laterdog-dev-server/235c/harness-mcp-proxy.js compute",
      "/usr/local/bin/node /tmp/laterdog-dev-server/235c/mcp-gate.js",
      "/usr/local/bin/node /tmp/laterdog-dev-server/235c/permission-proxy.js /data/x",
      "codex app-server",
    ]) expect(isEngineProcess(argv)).toBe(true);
    for (const argv of ["next-server (v16.3.8)", "node preview-server.mjs", "/data/.local/bin/cloudflared tunnel --url http://127.0.0.1:8787", "npm exec next dev --port 3000"]) {
      expect(isEngineProcess(argv)).toBe(false);
    }
  });
});

describe("when a stray is stopped", () => {
  const server: ProcessInfo = { pid: 50, ppid: 1, cwd: at("dog", "t1"), argv: "node preview-server.mjs" };
  it("stops it when its task is closed or deleted", () => {
    expect(reapReason({ ...server, ppid: 40 }, { ...live, closed: true }, now)).toBe("task closed");
    expect(reapReason({ ...server, ppid: 40 }, { exists: false, busy: false, closed: false, lastActiveAt: null }, now)).toBe("task gone");
  });

  it("stops a detached server only after its task has been idle for hours", () => {
    expect(reapReason(server, live, now)).toBeNull();
    expect(reapReason(server, { ...live, lastActiveAt: now - 7 * HOUR }, now)).toBe("orphan of an idle task");
    expect(reapReason({ ...server, ppid: 40 }, { ...live, lastActiveAt: now - 7 * HOUR }, now)).toBeNull();
  });

  it("never stops anything while the task is working", () => {
    expect(reapReason(server, { ...live, busy: true, closed: true }, now)).toBeNull();
  });
});

describe("stopping a stray", () => {
  it("stops its whole tree, first politely and then for good, and leaves engines and other tasks alone", () => {
    const procs: ProcessInfo[] = [
      { pid: 10, ppid: 1, cwd: at("dog", "closed"), argv: "npm exec next dev --port 3000" },
      { pid: 11, ppid: 10, cwd: at("dog", "closed"), argv: "sh -c next dev" },
      { pid: 12, ppid: 11, cwd: "/", argv: "next-server (v16.3.8)" },
      { pid: 20, ppid: 1, cwd: at("dog", "closed"), argv: "/usr/local/bin/claude --resume x" },
      { pid: 30, ppid: 1, cwd: at("dog", "open"), argv: "node preview-server.mjs" },
      { pid: 99, ppid: 1, cwd: at("dog", "closed"), argv: "node server" },
    ];
    const sent: string[] = [];
    let later: (() => void) | undefined;
    const reaped = reapStrays({
      roots: [ROOT],
      processes: () => procs,
      thread: (_bot, thread) => (thread === "closed" ? { ...live, closed: true } : live),
      signal: (pid, signal) => sent.push(`${signal}:${pid}`),
      later: (run) => { later = run; },
      self: 99,
      now: () => now,
    });
    expect(reaped.map((proc) => proc.pid)).toEqual([10, 11]);
    expect(sent.sort()).toEqual(["SIGTERM:10", "SIGTERM:11", "SIGTERM:12"]);
    later?.();
    expect(sent.filter((line) => line.startsWith("SIGKILL")).sort()).toEqual(["SIGKILL:10", "SIGKILL:11", "SIGKILL:12"]);
  });

  it("finds every descendant", () => {
    const all = [{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 3 }, { pid: 5, ppid: 1 }] as ProcessInfo[];
    expect(withDescendants([2], all).sort()).toEqual([2, 3, 4]);
  });
});

describe("when memory is tight", () => {
  const proc = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "reaper-proc-"));
    mkdirSync(join(dir, "pressure"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };

  it("reads available memory and the kernel's stall measure", () => {
    const dir = proc({
      meminfo: "MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:     400000 kB\n",
      "pressure/memory": "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    });
    expect(readMemoryPressure(dir)).toEqual({ availablePercent: 10, psiSomeAvg10: 12.5 });
    expect(readMemoryPressure(join(dir, "missing"))).toEqual({ availablePercent: null, psiSomeAvg10: null });
  });

  it("counts as tight under 15% available or when tasks stall on memory", () => {
    expect(underMemoryPressure({ availablePercent: 40, psiSomeAvg10: 0 })).toBe(false);
    expect(underMemoryPressure({ availablePercent: 14, psiSomeAvg10: null })).toBe(true);
    expect(underMemoryPressure({ availablePercent: 40, psiSomeAvg10: 11 })).toBe(true);
    expect(underMemoryPressure({ availablePercent: null, psiSomeAvg10: null })).toBe(false);
  });

  it("stops a detached server after 30 idle minutes instead of 6 hours", () => {
    const tight = orphanIdleHours({ availablePercent: 5, psiSomeAvg10: null });
    const relaxed = orphanIdleHours({ availablePercent: 60, psiSomeAvg10: 0 });
    const server: ProcessInfo = { pid: 50, ppid: 1, cwd: at("dog", "t1"), argv: "node preview-server.mjs" };
    const idleHour: ThreadState = { ...live, lastActiveAt: now - HOUR };
    expect(reapReason(server, idleHour, now, relaxed)).toBeNull();
    expect(reapReason(server, idleHour, now, tight)).toBe("orphan of an idle task");
    expect(reapReason(server, { ...live, lastActiveAt: now - 10 * 60_000 }, now, tight)).toBeNull();
    expect(reapReason(server, { ...idleHour, busy: true }, now, tight)).toBeNull();
    expect(reapReason({ ...server, ppid: 40 }, idleHour, now, tight)).toBeNull();
  });

  it("passes the tighter limit through to a sweep", () => {
    const sent: string[] = [];
    reapStrays({
      roots: [ROOT],
      processes: () => [{ pid: 50, ppid: 1, cwd: at("dog", "t1"), argv: "node preview-server.mjs" }],
      thread: () => ({ ...live, lastActiveAt: now - HOUR }),
      signal: (pid, signal) => sent.push(`${signal}:${pid}`),
      later: () => {},
      now: () => now,
      orphanIdleHours: PRESSURE_ORPHAN_MINUTES / 60,
    });
    expect(sent).toEqual(["SIGTERM:50"]);
  });
});
