import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISK_RUNGS, diskLadder, diskRung, fileLadderStore, STORE_PRUNE_EVERY_MS, TIDY_IDLE_MS, tidyIdleChats, tidyOrder, trackedByGit } from "./disk-ladder.ts";

const fresh = () => ({ cleared: {}, prunedAt: null });
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
  return { dir, busy: false, closed: false, lastActiveAt: NOW - TIDY_IDLE_MS - 1, ...over };
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
    const result = tidyIdleChats([quiet], [], untracked);
    expect(existsSync(join(quiet.dir, "app/node_modules"))).toBe(false);
    expect(existsSync(join(quiet.dir, "app/.next"))).toBe(false);
    expect(result.chats).toBe(1);
    expect(result.freed).toBeGreaterThan(100 * 1024);
  });

  it("never touches a chat where a turn is running", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const busy = chat(root, "busy", { busy: true, lastActiveAt: NOW - 30 * 24 * 60 * 60_000 });
    expect(tidyOrder([busy], fresh(), NOW)).toEqual([]);
  });

  it("only touches a chat idle for a day or more, and leaves a chat it knows nothing about", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const recent = chat(root, "recent", { lastActiveAt: NOW - TIDY_IDLE_MS + 60_000 });
    const unknown = chat(root, "unknown", { lastActiveAt: null });
    const gone = chat(root, "gone", { lastActiveAt: null, closed: true });
    const day = chat(root, "day", { lastActiveAt: NOW - TIDY_IDLE_MS });
    expect(tidyOrder([recent, unknown, gone, day], fresh(), NOW).map((c) => c.dir)).toEqual([gone.dir, day.dir]);
  });

  it("never touches source files or anything inside .git", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    tidyIdleChats([quiet], [], untracked);
    expect(readFileSync(join(quiet.dir, "app/page.tsx"), "utf8")).toBe("export default 1");
    expect(existsSync(join(quiet.dir, "app/.git/objects/blob"))).toBe(true);
    expect(existsSync(join(quiet.dir, "app/.git/.cache/blob"))).toBe(true);
  });

  it("never touches output a live process works in", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const quiet = chat(root, "quiet");
    tidyIdleChats([quiet], [{ pid: 9, ppid: 1, cwd: join(quiet.dir, "app"), argv: "node server.js" }], untracked);
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
    tidyIdleChats([{ dir: repo, busy: false, closed: true, lastActiveAt: null }], [], trackedByGit);
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
  function climb(share: number, names = ["quiet"], store = fileLadderStore(join(mkdtempSync(join(tmpdir(), "ladder-mem-")), "disk-ladder.json"))) {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const chats = names.map((name, at) => chat(root, name, { lastActiveAt: NOW - TIDY_IDLE_MS - (names.length - at) * 60_000 }));
    const lines: string[] = [];
    const calls: string[] = [];
    let free = share;
    let now = NOW;
    let freeAfterClear: number | null = null;
    const ladder = diskLadder({
      disk: () => disk(free),
      chats: () => chats,
      live: () => [],
      tracked: () => { if (freeAfterClear !== null) free = freeAfterClear; return false; },
      sweepTemp: () => { calls.push("temp"); return { removed: ["/t/x"], freed: 1024 ** 2 }; },
      pruneCaches: () => { calls.push("caches"); return 2 * 1024 ** 2; },
      log: (line) => lines.push(line),
      now: () => now,
      store,
    });
    return { ladder, lines, calls, chats, store, setFree: (next: number) => { free = next; }, freeAfterClear: (next: number) => { freeAfterClear = next; }, setNow: (next: number) => { now = next; } };
  }
  const kept = (c: WorkspaceTask) => existsSync(join(c.dir, "app/node_modules/react/blob"));

  it("does nothing while plenty is free", () => {
    const { ladder, lines, calls, chats } = climb(0.6);
    expect(ladder.climb().rung).toBe(0);
    expect(lines).toEqual([]);
    expect(calls).toEqual([]);
    expect(kept(chats[0]!)).toBe(true);
  });

  it("tidies on rung one without sweeping temp or caches, in one line naming chats and bytes", () => {
    const { ladder, lines, calls } = climb(0.3);
    expect(ladder.climb().rung).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^laterdog home: disk 30% free \(6\.0 GB of 20\.0 GB\); cleared rebuildable output in 1 chat\(s\), removed 0 temp item\(s\), freed \d+ MB$/);
  });

  it("also sweeps temp and prunes caches on rung two, still one line for the pass", () => {
    const { ladder, lines, calls } = climb(0.2);
    ladder.climb();
    expect(calls).toEqual(["temp", "caches"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/cleared rebuildable output in 1 chat\(s\), removed 1 temp item\(s\) and pruned package caches, freed \d+ MB$/);
  });

  it("writes nothing on a pass that removed nothing", () => {
    const { ladder, lines } = climb(0.3);
    ladder.climb();
    ladder.climb();
    expect(lines).toHaveLength(1);
  });

  it("works from the least recently used chat and stops once free space is five points above the rung", () => {
    const { ladder, chats, freeAfterClear } = climb(0.3, ["oldest", "middle", "newest"]);
    freeAfterClear(0.4);
    ladder.climb();
    expect(chats.map(kept)).toEqual([false, true, true]);
  });

  it("keeps going while free space stays under five points above the rung", () => {
    const { ladder, chats, freeAfterClear } = climb(0.3, ["oldest", "middle", "newest"]);
    freeAfterClear(0.399);
    ladder.climb();
    expect(chats.map(kept)).toEqual([false, false, false]);
  });

  it("never clears a chat twice until it has had a turn since, even after the home restarts", () => {
    const first = climb(0.2);
    first.ladder.climb();
    fill(join(first.chats[0]!.dir, "app/node_modules/react"));
    const later = NOW + 3 * TIDY_IDLE_MS;
    const again = diskLadder({ disk: () => disk(0.2), chats: () => first.chats, live: () => [], tracked: untracked, sweepTemp: () => ({ removed: [], freed: 0 }), pruneCaches: () => 0, log: () => {}, now: () => later, store: first.store });
    again.climb();
    expect(kept(first.chats[0]!)).toBe(true);
    first.chats[0]!.lastActiveAt = NOW + 60_000;
    again.climb();
    expect(kept(first.chats[0]!)).toBe(false);
  });

  it("prunes the package store at most once a day, and only from rung two", () => {
    const { ladder, calls, setNow, setFree } = climb(0.3);
    ladder.climb();
    expect(calls).not.toContain("caches");
    setFree(0.2);
    ladder.climb();
    setNow(NOW + STORE_PRUNE_EVERY_MS);
    ladder.climb();
    expect(calls.filter((c) => c === "caches")).toHaveLength(1);
    setNow(NOW + STORE_PRUNE_EVERY_MS + 1);
    ladder.climb();
    expect(calls.filter((c) => c === "caches")).toHaveLength(2);
  });

  it("tries the store prune again on the next pass when an install kept it from running", () => {
    const store = fileLadderStore(join(mkdtempSync(join(tmpdir(), "ladder-mem-")), "disk-ladder.json"));
    let installing = true;
    let tries = 0;
    let now = NOW;
    const ladder = diskLadder({
      disk: () => disk(0.2), chats: () => [], live: () => [], tracked: untracked,
      sweepTemp: () => ({ removed: [], freed: 0 }),
      pruneCaches: () => { tries += 1; return installing ? null : 0; },
      log: () => {}, now: () => now, store,
    });
    ladder.climb();
    expect(store.load().prunedAt).toBeNull();
    installing = false;
    now = NOW + 10 * 60_000;
    ladder.climb();
    expect(tries).toBe(2);
    expect(store.load().prunedAt).toBe(now);
  });
});

describe("a day on a nearly full disk", () => {
  it("never makes a working dog reinstall, prunes the store at most once and clears no chat twice", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-"));
    const repo = join(root, "dog", "chat", "app");
    const install = () => fill(join(repo, "node_modules/x"));
    let now = NOW;
    let lastTurn = now;
    let prunes = 0;
    let reinstalls = 0;
    const lines: string[] = [];
    const ladder = diskLadder({
      disk: () => ({ totalBytes: 19.2e9, freeBytes: 2.3e9 }),
      chats: () => [{ dir: join(root, "dog", "chat"), busy: false, closed: false, lastActiveAt: lastTurn }],
      live: () => [],
      tracked: untracked,
      sweepTemp: () => ({ removed: [], freed: 0 }),
      pruneCaches: () => { prunes += 1; return 0; },
      log: (line) => lines.push(line),
      now: () => now,
    });
    for (let minute = 0; minute <= 24 * 60; minute += 10) {
      now = NOW + minute * 60_000;
      if (minute % 30 === 0) {
        if (!existsSync(join(repo, "node_modules"))) reinstalls += 1;
        install();
        lastTurn = now;
      }
      ladder.climb();
    }
    expect(reinstalls).toBe(1);
    expect(prunes).toBeLessThanOrEqual(1);
    expect(lines).toEqual([]);
  });
});
