import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capThreadLogs, clearBuildOutput, findBuildOutput, isLowDisk, LOW_DISK_BYTES, pruneOldFiles, runJanitor, storageWords, workspaceIsIdle } from "./janitor.ts";

const DAY = 24 * 60 * 60 * 1000;
const scratch = () => mkdtempSync(join(tmpdir(), "janitor-"));

function lines(count: number, width = 100): string {
  return Array.from({ length: count }, (_, at) => JSON.stringify({ n: at, pad: "x".repeat(width) })).join("\n") + "\n";
}

describe("thread logs", () => {
  it("cuts every log over the cap to its newest whole lines and leaves small logs alone", () => {
    const dir = scratch();
    writeFileSync(join(dir, "big.ndjson"), lines(5000));
    writeFileSync(join(dir, "small.ndjson"), lines(10));
    const cap = 64 * 1024;
    const freed = capThreadLogs([dir], cap);
    const big = readFileSync(join(dir, "big.ndjson"), "utf8");
    expect(statSync(join(dir, "big.ndjson")).size).toBeLessThanOrEqual(cap);
    expect(big.split("\n").filter(Boolean).every((line) => JSON.parse(line).pad)).toBe(true);
    expect(JSON.parse(big.trim().split("\n").at(-1)!).n).toBe(4999);
    expect(readFileSync(join(dir, "small.ndjson"), "utf8")).toBe(lines(10));
    expect(freed).toBeGreaterThan(400_000);
  });
});

describe("old spilled tool results", () => {
  it("removes files older than the limit and the folders they leave empty", () => {
    const dir = scratch();
    mkdirSync(join(dir, "old-thread"));
    mkdirSync(join(dir, "new-thread"));
    writeFileSync(join(dir, "old-thread", "a.txt"), "x".repeat(10_000));
    writeFileSync(join(dir, "new-thread", "b.txt"), "fresh");
    const old = new Date(Date.now() - 10 * DAY);
    utimesSync(join(dir, "old-thread", "a.txt"), old, old);
    expect(pruneOldFiles(dir, 7)).toBeGreaterThan(0);
    expect(existsSync(join(dir, "old-thread"))).toBe(false);
    expect(existsSync(join(dir, "new-thread", "b.txt"))).toBe(true);
  });
});

describe("build output in task workspaces", () => {
  const now = Date.now();
  it("only touches tasks that are closed, gone, or idle for days, never a working one", () => {
    expect(workspaceIsIdle({ dir: "", busy: true, closed: true, lastActiveAt: 0 }, now)).toBe(false);
    expect(workspaceIsIdle({ dir: "", busy: false, closed: true, lastActiveAt: now }, now)).toBe(true);
    expect(workspaceIsIdle({ dir: "", busy: false, closed: false, lastActiveAt: now - DAY }, now)).toBe(false);
    expect(workspaceIsIdle({ dir: "", busy: false, closed: false, lastActiveAt: now - 4 * DAY }, now)).toBe(true);
    expect(workspaceIsIdle({ dir: "", busy: false, closed: false, lastActiveAt: null }, now)).toBe(false);
  });

  it("deletes node_modules and .next but keeps source, dist and anything under .git", () => {
    const dir = scratch();
    for (const path of ["app/node_modules/react", "app/.next/cache", "app/src", "app/dist", ".git/node_modules"]) mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, "app/node_modules/react/index.js"), "x".repeat(5000));
    writeFileSync(join(dir, "app/src/page.tsx"), "export {}");
    writeFileSync(join(dir, "app/dist/site.html"), "<html>");
    expect(findBuildOutput(dir).map((path) => path.slice(dir.length + 1)).sort()).toEqual(["app/.next", "app/node_modules"]);
    const { freed } = clearBuildOutput([{ dir, busy: false, closed: true, lastActiveAt: now }], now);
    expect(freed).toBeGreaterThan(0);
    expect(existsSync(join(dir, "app/node_modules"))).toBe(false);
    expect(existsSync(join(dir, "app/src/page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app/dist/site.html"))).toBe(true);
    expect(existsSync(join(dir, ".git/node_modules"))).toBe(true);
  });

  it("leaves a busy task's build output alone", () => {
    const dir = scratch();
    mkdirSync(join(dir, "node_modules"));
    clearBuildOutput([{ dir, busy: true, closed: true, lastActiveAt: 0 }], now);
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
  });
});

describe("low disk", () => {
  it("is under 2 GB free and warns in plain words", () => {
    expect(isLowDisk({ totalBytes: 20e9, freeBytes: LOW_DISK_BYTES - 1 })).toBe(true);
    expect(isLowDisk({ totalBytes: 20e9, freeBytes: LOW_DISK_BYTES })).toBe(false);
    expect(isLowDisk(null)).toBe(false);
    expect(storageWords({ totalBytes: 20e9, freeBytes: 0.4 * 1024 ** 3 })).toMatch(/^Your Cloud home is almost out of space \(0\.4 GB left\)/);
    expect(storageWords({ totalBytes: 20e9, freeBytes: 8e9 })).toBeNull();
  });
});

describe("a janitor run", () => {
  it("runs every step, adds up what it freed, and keeps going when one step fails", () => {
    const dir = scratch();
    writeFileSync(join(dir, "t.ndjson"), lines(3000));
    let swept = false;
    const run = runJanitor({
      dataDir: dir,
      logDirs: [dir],
      logMaxBytes: 32 * 1024,
      sweepRetention: () => { swept = true; },
      toolResultsDir: join(dir, "none"),
      workspaceTasks: () => { throw new Error("store unavailable"); },
      reap: () => 2,
      vacuum: () => 0,
    }, "scheduled");
    expect(swept).toBe(true);
    expect(run.steps.logs).toBeGreaterThan(0);
    expect(run.steps.buildOutput).toBe(0);
    expect(run.reaped).toBe(2);
    expect(run.freedBytes).toBe(run.steps.logs);
  });
});
