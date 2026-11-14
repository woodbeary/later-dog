import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeAncestors, markIn, openPaths, readHomeProcesses, type HomeProcess } from "./home-processes.ts";
import { endLeftovers, leftoverRoots, leftoversLine } from "./turn-leftovers.ts";
import { turnUpkeep } from "./turn-upkeep.ts";
import { chatEngineEnvironment } from "./chat-environment.ts";

const SERVER = 21;
const proc = (pid: number, ppid: number, argv: string, mark: string | null, started = pid * 10): HomeProcess => ({ pid, ppid, started, argv, cwd: "/data", mark });

function home(): HomeProcess[] {
  return [
    proc(1, 0, "/usr/bin/tini -- node run.mjs", null),
    proc(7, 1, "node /app/cloud/runtime/run.mjs", null),
    proc(SERVER, 7, "node /app/server/index.js", null),
    proc(30, SERVER, "/usr/local/bin/claude --resume s1", "chat-a"),
    proc(31, 30, "node /tmp/laterdog-dev-server/x/mcp-gate.js", "chat-a"),
    proc(32, 30, "/bin/bash -c sleep 900 & wait", "chat-a"),
    proc(33, 30, "npx some-helper-server", "chat-a"),
    proc(40, 1, "node dev-server.mjs", "chat-a"),
    proc(41, 40, "esbuild --watch", "chat-a"),
    proc(42, 41, "cat", null),
    proc(50, 1, "git grep needle", "chat-b"),
    proc(51, SERVER, "tar -cf - .", null),
    proc(60, 1, "python3 cron.py", null),
    proc(70, 1, "node /tmp/laterdog-dev-server/x/harness-mcp-proxy.js", "chat-a"),
  ];
}

function run(all: HomeProcess[], reread: (pid: number) => HomeProcess | null = (pid) => all.find((p) => p.pid === pid) ?? null) {
  const signals: [number, string][] = [];
  let firm: (() => void) | null = null;
  const ended = endLeftovers({ mark: "chat-a", processes: () => all, reread, signal: (pid, sig) => signals.push([pid, sig]), later: (go) => { firm = go; }, self: SERVER });
  return { ended, signals, firm: () => firm?.() };
}

describe("what a turn leaves running on the home", () => {
  it("ends a process the chat started that is no longer under its engine, with everything under it", () => {
    const { ended, signals, firm } = run(home());
    expect(ended.map((p) => p.pid)).toEqual([40]);
    expect(signals).toEqual([[40, "SIGTERM"], [41, "SIGTERM"], [42, "SIGTERM"]]);
    firm();
    expect(signals.slice(3)).toEqual([[40, "SIGKILL"], [41, "SIGKILL"], [42, "SIGKILL"]]);
  });

  it("never touches the home's server, its launcher or pid 1", () => {
    const all = home().map((p) => (p.pid === SERVER || p.pid === 7 || p.pid === 1 ? { ...p, mark: "chat-a" } : p));
    const { signals, firm } = run(all);
    firm();
    for (const pid of [1, 7, SERVER]) expect(signals.some(([target]) => target === pid)).toBe(false);
  });

  it("never touches the engine or what runs under it: its helpers and its own background shells", () => {
    const { signals, firm } = run(home());
    firm();
    for (const pid of [30, 31, 32, 33]) expect(signals.some(([target]) => target === pid)).toBe(false);
  });

  it("never touches another chat's processes, even when they are left over too", () => {
    const { signals, firm } = run(home());
    firm();
    expect(signals.some(([target]) => target === 50)).toBe(false);
  });

  it("never touches a process outside any chat: the home's own work and a computer run's upload", () => {
    const { signals, firm } = run(home());
    firm();
    for (const pid of [51, 60]) expect(signals.some(([target]) => target === pid)).toBe(false);
  });

  it("leaves an engine helper alone even when it has lost its engine", () => {
    expect(leftoverRoots("chat-a", home(), SERVER).some((p) => p.pid === 70)).toBe(false);
  });

  it("does not force a pid that now belongs to a different process", () => {
    const all = home();
    const { signals, firm } = run(all, (pid) => (pid === 41 ? proc(41, 1, "something new", null, 999) : pid === 42 ? null : all.find((p) => p.pid === pid)!));
    firm();
    expect(signals.filter(([, sig]) => sig === "SIGKILL")).toEqual([[40, "SIGKILL"]]);
  });

  it("does nothing when nothing was left", () => {
    const { ended, signals } = run(home().filter((p) => p.pid < 40 || p.pid >= 50));
    expect(ended).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("names what it stopped in one log line", () => {
    const line = leftoversLine("chat-a-long-id", [proc(40, 1, "node   dev-server.mjs", "chat-a")]);
    expect(line).toBe('laterdog home: chat chat-a-l finished its turn; stopped 1 process(es) it left running: "node dev-server.mjs" (pid 40)');
  });
});

describe("after a turn ends", () => {
  function upkeep(atWork: boolean) {
    const swept: string[] = [];
    const lines: string[] = [];
    const queued: (() => void)[] = [];
    const listen = turnUpkeep({
      atWork: () => atWork,
      endLeftovers: (mark) => { swept.push(mark); return [proc(40, 1, "node dev-server.mjs", mark)]; },
      log: (line) => lines.push(line),
      later: (go) => queued.push(go),
    });
    return { listen, swept, lines, settle: () => queued.splice(0).forEach((go) => go()) };
  }

  it("sweeps the chat once the turn has settled and logs one line", () => {
    const { listen, swept, lines, settle } = upkeep(false);
    listen({ type: "turn.completed", threadId: "chat-a" });
    expect(swept).toEqual([]);
    settle();
    expect(swept).toEqual(["chat-a"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^laterdog home: /);
  });

  it("never sweeps a chat where a turn or a helper is running again", () => {
    const { listen, swept, settle } = upkeep(true);
    listen({ type: "turn.completed", threadId: "chat-a" });
    settle();
    expect(swept).toEqual([]);
  });

  it("ignores everything but a turn's end and the engine's exit", () => {
    const { listen, swept, settle } = upkeep(false);
    listen({ type: "turn.started", threadId: "chat-a" });
    listen({ type: "item.completed", threadId: "chat-a" });
    settle();
    expect(swept).toEqual([]);
  });
});

describe("reading the home's processes", () => {
  it("reads each process's chat, parent and start time", () => {
    const dir = mkdtempSync(join(tmpdir(), "procs-"));
    const add = (pid: number, ppid: number, environ: string, argv: string) => {
      mkdirSync(join(dir, String(pid), "fd"), { recursive: true });
      writeFileSync(join(dir, String(pid), "stat"), `${pid} (a b) S ${ppid} 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 ${pid}77 1 1`);
      writeFileSync(join(dir, String(pid), "environ"), environ);
      writeFileSync(join(dir, String(pid), "cmdline"), argv);
      symlinkSync("/data/work", join(dir, String(pid), "cwd"));
    };
    add(5, 1, "PATH=/bin\0LATERDOG_CHAT=chat-a\0", "sleep\u0000900\u0000");
    add(6, 5, "PATH=/bin\0", "cat\0");
    symlinkSync("/data/work/out.log", join(dir, "5", "fd", "1"));
    const found = readHomeProcesses(dir).sort((a, b) => a.pid - b.pid);
    expect(found).toEqual([
      { pid: 5, ppid: 1, started: 577, argv: "sleep 900", cwd: "/data/work", mark: "chat-a" },
      { pid: 6, ppid: 5, started: 677, argv: "cat", cwd: "/data/work", mark: null },
    ]);
    expect(openPaths(5, dir)).toEqual(["/data/work/out.log"]);
  });

  it("reads the mark only from its own variable", () => {
    expect(markIn("A=1\0LATERDOG_CHAT=x\0")).toBe("x");
    expect(markIn("NOT_LATERDOG_CHAT=x\0")).toBeNull();
    expect(markIn("LATERDOG_CHAT=\0")).toBeNull();
  });

  it("counts the server's whole line of parents as the home", () => {
    expect([...homeAncestors(SERVER, home())].sort((a, b) => a - b)).toEqual([1, 7, SERVER]);
  });

  it("gives every engine its chat's mark", () => {
    expect(chatEngineEnvironment("chat-a")).toEqual({ LATERDOG_CHAT: "chat-a" });
  });
});
