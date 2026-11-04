import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dogJobs, lowOnMemory, memoryGuard, MEMORY_GUARD_SETTLE_MS, readMemoryRoom, type MemoryRoom, type SizedProcess } from "./memory-guard.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const proc = (pid: number, ppid: number, argv: string, rssMb = 10): SizedProcess => ({ pid, ppid, cwd: "/data", argv, rssBytes: rssMb * MB });

const home: SizedProcess[] = [
  proc(1, 0, "/usr/bin/tini -- node /app/cloud/runtime/run.mjs", 1),
  proc(7, 1, "node /app/cloud/runtime/run.mjs", 60),
  proc(21, 7, "node /tmp/laterdog-dev-server/abc/cloud-home-start.js", 600),
  proc(30, 21, "caddy run --config /tmp/Caddyfile --adapter caddyfile", 40),
  proc(31, 21, "ffmpeg -i note.m4a note.wav", 900),
  proc(40, 21, "/usr/local/bin/claude --resume one", 450),
  proc(41, 40, "/bin/bash -c pnpm typecheck", 4),
  proc(42, 41, "node node_modules/.bin/tsc --noEmit", 2600),
  proc(50, 21, "/usr/local/bin/claude --resume two", 400),
  proc(51, 50, "/bin/bash -c python3 shot.py", 3),
  proc(52, 51, "python3 shot.py", 80),
  proc(53, 52, "/opt/chromium/chrome --headless", 900),
  proc(60, 1, "bash -c ./run-e2e.sh", 2),
  proc(61, 60, "/opt/chromium/chrome --headless", 1200),
];

describe("which processes are a dog's job", () => {
  it("groups each command a dog started with everything under it, biggest first", () => {
    const jobs = dogJobs(home, 21);
    expect(jobs.map((job) => [job.root.pid, job.pids.sort(), Math.round(job.rssBytes / MB)])).toEqual([
      [41, [41, 42], 2604],
      [60, [60, 61], 1202],
      [51, [51, 52, 53], 983],
    ]);
  });

  it("never offers the launcher, the server, Caddy, the server's own helpers or a dog's engine", () => {
    const pids = dogJobs(home, 21).flatMap((job) => job.pids);
    for (const kept of [1, 7, 21, 30, 31, 40, 50]) expect(pids).not.toContain(kept);
  });
});

describe("when memory is low", () => {
  it("counts the room as low under 768 MB or 7% of the machine, whichever is larger", () => {
    expect(lowOnMemory({ totalBytes: 12 * GB, availableBytes: 900 * MB })).toBe(false);
    expect(lowOnMemory({ totalBytes: 12 * GB, availableBytes: 800 * MB })).toBe(true);
    expect(lowOnMemory({ totalBytes: 4 * GB, availableBytes: 700 * MB })).toBe(true);
    expect(lowOnMemory({ totalBytes: 4 * GB, availableBytes: 800 * MB })).toBe(false);
  });

  it("stops the biggest dog job, says so, then waits for memory to come back before stopping another", () => {
    let room: MemoryRoom = { totalBytes: 12 * GB, availableBytes: 300 * MB };
    let clock = 0;
    const killed: number[] = [];
    const lines: string[] = [];
    const guard = memoryGuard({ room: () => room, processes: () => home, kill: (pid) => killed.push(pid), log: (line) => lines.push(line), self: 21, now: () => clock });
    expect(guard.check()?.root.pid).toBe(41);
    expect(killed.sort()).toEqual([41, 42]);
    expect(lines[0]).toBe('cloud home: memory low (300 MB available of 12288 MB); stopped "/bin/bash -c pnpm typecheck" (pid 41 and 1 more, 2604 MB) so the home keeps answering');
    clock += MEMORY_GUARD_SETTLE_MS - 1;
    expect(guard.check()).toBeNull();
    clock += 1;
    room = { ...room, availableBytes: 4 * GB };
    expect(guard.check()).toBeNull();
    expect(killed).toHaveLength(2);
  });

  it("does nothing when there is room or no dog job to stop", () => {
    const quiet = memoryGuard({ room: () => ({ totalBytes: 12 * GB, availableBytes: 300 * MB }), processes: () => home.filter((p) => ![41, 42, 51, 52, 53, 60, 61].includes(p.pid)), kill: () => { throw new Error("nothing to stop"); }, log: () => undefined, self: 21 });
    expect(quiet.check()).toBeNull();
    expect(memoryGuard({ room: () => ({ totalBytes: 12 * GB, availableBytes: 6 * GB }), processes: () => { throw new Error("not read"); }, self: 21 }).check()).toBeNull();
  });

  it("reads the machine's room from meminfo", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-guard-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meminfo"), "MemTotal:       12508160 kB\nMemFree:          200000 kB\nMemAvailable:     315392 kB\n");
    expect(readMemoryRoom(dir)).toEqual({ totalBytes: 12508160 * 1024, availableBytes: 315392 * 1024 });
    expect(readMemoryRoom(join(dir, "missing"))).toBeNull();
  });
});
