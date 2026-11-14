import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISK_RUNGS, diskLadder, diskRung, TIDY_QUIET_MS, tidyQuietChats, trackedByGit } from "./disk-ladder.ts";
import type { WorkspaceTask } from "./janitor.ts";

const GB = 1024 ** 3;
const NOW = 1_000_000_000_000;
const disk = (freeShare: number) => ({ totalBytes: 20 * GB, freeBytes: Math.round(20 * GB * freeShare) });
const untracked = () => false;

function fill(path: string, bytes = 64 * 1024) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "blob"), Buffer.alloc(bytes, 1));
}

function chat(root: string, name: string, over: Partial<WorkspaceTask> = {}): WorkspaceTask {
  const dir = join(root, "dog", name);
  fill(join(dir, "app/node_modules/react"));
  fill(join(dir, "app/.next/cache"));
  writeFileSync(join(dir, "app/page.tsx"), "export default 1");
  fill(join(dir, "app/.git/objects"));
  fill(join(dir, "app/.git/.cache"));
  return { dir, busy: false, closed: false, lastActiveAt: NOW - TIDY_QUIET_MS - 1, ...over };
}

describe("the disk ladder's rungs", () => {
  it("are set in one place, mildest first, and act long before the old low-disk mark", () => {
    expect(DISK_RUNGS.map((step) => step.name)).toEqual(["tidy", "sweep", "move", "refuse", "floor"]);
    expect(DISK_RUNGS.every((step, at) => at === 0 || step.freeBelow < DISK_RUNGS[at - 1]!.freeBelow)).toBe(true);
    expect(diskRung(disk(0.5))).toBe(0);
    expect(diskRung(disk(0.34))).toBe(1);
    expect(diskRung(disk(0.2))).toBe(2);
    expect(diskRung({ totalBytes: 19.2 * GB, freeBytes: 3.1 * GB })).toBe(2);
    expect(diskRung(disk(0.01))).toBe(5);
    expect(diskRung(null)).toBe(0);
  });
});

describe("rung one: rebuildable output of quiet chats", () => {
  it("clears node_modules and build caches of a chat with no turn running", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    const result = tidyQuietChats([quiet], [], untracked, NOW);
    expect(existsSync(join(quiet.dir, "app/node_modules"))).toBe(false);
    expect(existsSync(join(quiet.dir, "app/.next"))).toBe(false);
    expect(result.chats).toBe(1);
    expect(result.freed).toBeGreaterThan(100 * 1024);
  });

  it("never touches a chat where a turn is running", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const busy = chat(root, "busy", { busy: true, lastActiveAt: NOW - 30 * 24 * 60 * 60_000 });
    tidyQuietChats([busy], [], untracked, NOW);
    expect(existsSync(join(busy.dir, "app/node_modules/react/blob"))).toBe(true);
  });

  it("waits until a chat has been quiet for a while, and leaves a chat it knows nothing about", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const recent = chat(root, "recent", { lastActiveAt: NOW - 60_000 });
    const unknown = chat(root, "unknown", { lastActiveAt: null });
    tidyQuietChats([recent, unknown], [], untracked, NOW);
    expect(existsSync(join(recent.dir, "app/node_modules/react/blob"))).toBe(true);
    expect(existsSync(join(unknown.dir, "app/node_modules/react/blob"))).toBe(true);
  });

  it("never touches source files or anything inside .git", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    tidyQuietChats([quiet], [], untracked, NOW);
    expect(readFileSync(join(quiet.dir, "app/page.tsx"), "utf8")).toBe("export default 1");
    expect(existsSync(join(quiet.dir, "app/.git/objects/blob"))).toBe(true);
    expect(existsSync(join(quiet.dir, "app/.git/.cache/blob"))).toBe(true);
  });

  it("never touches output a live process works in", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    tidyQuietChats([quiet], [{ pid: 9, ppid: 1, cwd: join(quiet.dir, "app"), argv: "node server.js" }], untracked, NOW);
    expect(existsSync(join(quiet.dir, "app/node_modules/react/blob"))).toBe(true);
  });

  it("never removes a folder the repository tracks, even one named like build output", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const repo = join(root, "dog", "vendored");
    fill(join(repo, "node_modules/kept"));
    fill(join(repo, ".cache/scratch"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q");
    git("add", "-f", "node_modules/kept/blob");
    expect(trackedByGit(join(repo, "node_modules"))).toBe(true);
    expect(trackedByGit(join(repo, ".cache"))).toBe(false);
    tidyQuietChats([{ dir: repo, busy: false, closed: true, lastActiveAt: null }], [], trackedByGit, NOW);
    expect(existsSync(join(repo, "node_modules/kept/blob"))).toBe(true);
    expect(existsSync(join(repo, ".cache"))).toBe(false);
  });

  it("treats a folder outside any repository as untracked, and one it cannot check as tracked", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    fill(join(root, "node_modules/x"));
    expect(trackedByGit(join(root, "node_modules"))).toBe(false);
    expect(trackedByGit(join(root, "missing/node_modules"))).toBe(true);
  });
});

describe("climbing the ladder", () => {
  function climb(share: number) {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    const lines: string[] = [];
    const calls: string[] = [];
    let free = share;
    const ladder = diskLadder({
      disk: () => disk(free),
      chats: () => [quiet],
      live: () => [],
      tracked: untracked,
      sweepTemp: () => { calls.push("temp"); return { removed: ["/t/x"], freed: 1024 ** 2 }; },
      pruneCaches: () => { calls.push("caches"); return 2 * 1024 ** 2; },
      log: (line) => lines.push(line),
      now: () => NOW,
    });
    return { ladder, lines, calls, quiet, setFree: (next: number) => { free = next; } };
  }

  it("does nothing while plenty is free", () => {
    const { ladder, lines, calls, quiet } = climb(0.6);
    expect(ladder.climb().rung).toBe(0);
    expect(lines).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(quiet.dir, "app/node_modules"))).toBe(true);
  });

  it("tidies on rung one without sweeping temp or caches", () => {
    const { ladder, lines, calls } = climb(0.3);
    expect(ladder.climb().rung).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^laterdog home: disk 30% free \(6\.0 GB of 20\.0 GB\); cleared rebuildable output in 1 quiet chat\(s\), freed \d+ MB$/);
  });

  it("also sweeps temp and prunes caches on rung two, one line per rung", () => {
    const { ladder, lines, calls } = climb(0.2);
    ladder.climb();
    expect(calls).toEqual(["temp", "caches"]);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("laterdog home: "))).toBe(true);
    expect(lines[1]).toMatch(/removed 1 temp item\(s\) no turn was using and pruned package caches, freed 3 MB$/);
  });

  it("stays quiet on a later check that finds nothing new to clear on a rung already reached", () => {
    const { ladder, lines } = climb(0.3);
    ladder.climb();
    ladder.climb();
    expect(lines).toHaveLength(1);
  });
});
