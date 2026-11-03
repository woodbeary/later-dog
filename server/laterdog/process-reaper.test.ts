import { describe, expect, it } from "vitest";
import { isEngineProcess, reapReason, reapStrays, withDescendants, workspaceThread, type ProcessInfo, type ThreadState } from "./process-reaper.ts";

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
