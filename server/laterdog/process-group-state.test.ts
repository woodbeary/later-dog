import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { parseProcStat, processGroupHoldsOnlyZombies, type ProcReader } from "./process-group-state.ts";

const SELF = 7;

function stat(pid: number, state: string, group: number, comm = "node"): string {
  return `${pid} (${comm}) ${state} 1 ${group} ${group} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0`;
}

function fakeProc(rows: Record<number, string | null>, self = SELF): ProcReader {
  const table: Record<string, string | null> = { [self]: stat(self, "S", self), ...rows };
  return { pids: () => Object.keys(table), stat: (pid) => table[pid] ?? null };
}

const onLinux = (reader: ProcReader) => ({ platform: "linux" as const, reader, self: SELF });

describe("reading /proc/<pid>/stat", () => {
  it("reads the state and process group even when the command name has spaces and parentheses", () => {
    expect(parseProcStat(stat(4242, "Z", 4200, "claude (helper) x"))).toEqual({ pid: 4242, state: "Z", group: 4200 });
    expect(parseProcStat("12 (a) b) R 1 9 9 0")).toEqual({ pid: 12, state: "R", group: 9 });
  });

  it.each(["", "12", "12 (node", "(node) S 1 9", "12 (node) S 1"])("refuses a line it cannot read: %j", (line) => {
    expect(parseProcStat(line)).toBeNull();
  });
});

describe("a process group whose only members left are zombies", () => {
  it("counts as stopped, while other groups' live processes do not matter", () => {
    const reader = fakeProc({ 101: stat(101, "Z", 100), 102: stat(102, "Z", 100), 203: stat(203, "S", 200), 1: stat(1, "S", 1) });
    expect(processGroupHoldsOnlyZombies(100, onLinux(reader))).toBe(true);
  });

  it("counts members that are already dead (X) as stopped too", () => {
    expect(processGroupHoldsOnlyZombies(100, onLinux(fakeProc({ 101: stat(101, "X", 100), 102: stat(102, "Z", 100) })))).toBe(true);
  });

  it.each(["R", "S", "D", "T", "t", "I", "W", "P"])("is still running while one member is in state %s", (state) => {
    const reader = fakeProc({ 101: stat(101, "Z", 100), 102: stat(102, state, 100) });
    expect(processGroupHoldsOnlyZombies(100, onLinux(reader))).toBe(false);
  });

  it("counts a group that disappeared between the signal probe and the scan as stopped", () => {
    expect(processGroupHoldsOnlyZombies(100, onLinux(fakeProc({ 203: stat(203, "S", 200) })))).toBe(true);
  });

  it("skips a process that exits while the scan reads it", () => {
    expect(processGroupHoldsOnlyZombies(100, onLinux(fakeProc({ 101: stat(101, "Z", 100), 102: null })))).toBe(true);
  });

  it("refuses to decide from a stat line it cannot read", () => {
    expect(processGroupHoldsOnlyZombies(100, onLinux(fakeProc({ 101: stat(101, "Z", 100), 102: "garbage" })))).toBe(false);
  });

  it("refuses when /proc cannot be listed, or does not show this server's own process", () => {
    const broken: ProcReader = { pids: () => { throw new Error("ENOENT"); }, stat: () => null };
    expect(processGroupHoldsOnlyZombies(100, onLinux(broken))).toBe(false);
    const foreign = fakeProc({ 101: stat(101, "Z", 100) }, 99);
    expect(processGroupHoldsOnlyZombies(100, onLinux(foreign))).toBe(false);
  });

  it("only answers on Linux, and never for init or a made-up group", () => {
    const reader = fakeProc({ 101: stat(101, "Z", 100) });
    expect(processGroupHoldsOnlyZombies(100, { platform: "darwin", reader, self: SELF })).toBe(false);
    expect(processGroupHoldsOnlyZombies(100, { platform: "win32", reader, self: SELF })).toBe(false);
    for (const group of [0, 1, -100, 1.5, Number.NaN]) expect(processGroupHoldsOnlyZombies(group, onLinux(reader))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("reads this machine's real /proc: a live group is running, a reaped one is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      expect(processGroupHoldsOnlyZombies(child.pid!)).toBe(false);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    expect(processGroupHoldsOnlyZombies(child.pid!)).toBe(true);
  });
});
