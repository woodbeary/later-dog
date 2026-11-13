import { spawn } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BREAKDOWN_FILE, breakdownLine, createDiskBreakdown, planBreakdown, type DiskBreakdown } from "./disk-breakdown.ts";
import { walkState, walkTree } from "./disk-walk.ts";
import { BUILD_OUTPUT_DIRS } from "./janitor.ts";

const MB = 1024 * 1024;
const SLACK = 512 * 1024;
const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
});

function file(path: string, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), "disk-breakdown-"));
  const home = join(root, "home");
  const data = join(home, ".laterdog");
  const outside = join(root, "outside");
  file(join(outside, "huge.bin"), 8 * MB);
  const ada = join(data, "task-workspaces", "ada", "thread-1");
  file(join(ada, "secret-plan.txt"), 1 * MB);
  file(join(ada, "node_modules", "left", "index.js"), 1 * MB);
  file(join(ada, "node_modules", "left", "node_modules", "inner", "index.js"), 1 * MB);
  file(join(ada, ".git", "objects", "pack.bin"), 2 * MB);
  file(join(ada, "site", ".wrangler", "tmp", "bundle.js"), 1 * MB);
  symlinkSync(join(outside, "huge.bin"), join(ada, "link-to-huge"));
  symlinkSync(outside, join(ada, "link-to-outside"));
  file(join(data, "task-workspaces", "bea", "thread-2", "notes.txt"), 3 * MB);
  file(join(data, "messages.db"), 2 * MB);
  file(join(data, "config.json"), 1000);
  file(join(data, "attachments", "photo.jpg"), 1 * MB);
  file(join(data, "providers", "acct", "projects", "s.jsonl"), 1 * MB);
  file(join(data, "mystery", "blob.bin"), 1 * MB);
  file(join(home, ".claude", "projects", "s.jsonl"), 1 * MB);
  file(join(home, ".local", "share", "pnpm", "store", "pkg.tgz"), 2 * MB);
  file(join(home, ".local", "bin", "tool"), 1 * MB);
  file(join(home, ".cache", "pip", "wheel.whl"), 1 * MB);
  file(join(home, "my-project", "readme.md"), 1 * MB);
  return { root, home, data, ada, outside };
}

const job = { generatedNames: [...BUILD_OUTPUT_DIRS] };

describe("walking one folder", () => {
  it("counts generated output and version history apart, never follows links and counts a hard link once", () => {
    const { ada, outside } = tree();
    linkSync(join(ada, "secret-plan.txt"), join(ada, "same-plan.txt"));
    const result = walkTree({ key: "dog:ada", paths: [ada], split: true }, Infinity, walkState(job));
    expect(result.atLeast).toBeUndefined();
    expect(result.generated).toBeGreaterThanOrEqual(3 * MB);
    expect(result.generated).toBeLessThan(3 * MB + SLACK);
    expect(result.history).toBeGreaterThanOrEqual(2 * MB);
    expect(result.history).toBeLessThan(2 * MB + SLACK);
    expect(result.bytes - result.generated! - result.history!).toBeGreaterThanOrEqual(1 * MB);
    expect(result.bytes).toBeLessThan(6 * MB + SLACK);
    expect(walkTree({ key: "outside", paths: [outside], split: false }, Infinity, walkState(job)).bytes).toBeGreaterThanOrEqual(8 * MB);
  });

  it("says at least when a folder cannot be read", () => {
    if (process.getuid?.() === 0) return;
    const { ada } = tree();
    const shut = join(ada, "shut");
    file(join(shut, "hidden.bin"), 1 * MB);
    chmodSync(shut, 0);
    locked.push(shut);
    const result = walkTree({ key: "dog:ada", paths: [ada], split: true }, Infinity, walkState(job));
    expect(result.atLeast).toBe(true);
    expect(result.bytes).toBeGreaterThanOrEqual(6 * MB);
  });

  it("stops at its time limit and reports what it counted so far as at least", () => {
    const { ada } = tree();
    let tick = 0;
    const state = walkState({ ...job, pauseEvery: 1 }, () => tick++);
    const result = walkTree({ key: "dog:ada", paths: [ada], split: true }, 4, state);
    expect(result.atLeast).toBe(true);
    expect(result.bytes).toBeLessThan(6 * MB);
  });
});

describe("planning the measurement", () => {
  it("names each dog's folder, splits the home's folders into areas and leaves the data folder out of the home's", async () => {
    const { home, data } = tree();
    const plan = await planBreakdown({ dataDir: data, home, scratch: [] });
    const keys = plan.roots.map((root) => root.key);
    expect(keys[0]).toBe("packages");
    expect(plan.dogs.sort()).toEqual(["ada", "bea"]);
    expect(keys).toEqual(expect.arrayContaining(["dog:ada", "dog:bea", "database", "data-files", "attachments", "engine-sessions", "data:mystery", "programs", "caches", "home-projects"]));
    expect(plan.roots.find((root) => root.key === "engine-sessions")!.paths).toEqual([join(data, "providers"), join(home, ".claude")]);
    expect(plan.roots.find((root) => root.key === "programs")!.skip).toEqual([join(home, ".local", "share", "pnpm")]);
    expect(plan.roots.flatMap((root) => root.paths)).not.toContain(data);
  });

  it("measures only the data folder when there is no home to look at", async () => {
    const { data } = tree();
    const plan = await planBreakdown({ dataDir: data, home: null, scratch: [] });
    expect(plan.roots.every((root) => root.paths.every((path) => path.startsWith(data)))).toBe(true);
  });
});

describe("the measured breakdown", () => {
  it("runs one walk at a time in a child process, keeps the result across a restart and logs the largest areas", async () => {
    const { home, data, root } = tree();
    const lines: string[] = [];
    const deps = { dataDir: data, home, scratch: [], dogName: (id: string) => (id === "ada" ? "Ada" : null), log: (line: string) => lines.push(line) };
    const runner = createDiskBreakdown(deps);
    expect(runner.last()).toBeNull();
    expect(runner.measure()).toBe(true);
    expect(runner.measure()).toBe(false);
    expect(runner.running()).toBe(true);
    const result = (await runner.settled())!;
    expect(runner.running()).toBe(false);
    expect(result.complete).toBe(true);
    const row = (area: string) => result.entries.find((entry) => entry.area === area)!;
    expect(row("workspaces").bytes).toBeGreaterThanOrEqual(9 * MB);
    expect(row("workspaces").bytes).toBeLessThan(9 * MB + SLACK);
    expect(row("workspaces-generated").within).toBe("workspaces");
    expect(row("dog:ada")).toMatchObject({ label: "Ada", dogId: "ada", dogName: "Ada", within: "workspaces" });
    expect(row("dog:bea")).toMatchObject({ label: "A removed dog", dogId: "bea" });
    expect(row("packages").bytes).toBeGreaterThanOrEqual(2 * MB);
    expect(row("programs").bytes).toBeLessThan(1 * MB + SLACK);
    expect(row("engine-sessions").bytes).toBeGreaterThanOrEqual(2 * MB);
    const top = result.entries.filter((entry) => !entry.within);
    expect(top[0]!.area).toBe("workspaces");
    expect(top.map((entry) => entry.bytes)).toEqual(top.map((entry) => entry.bytes).sort((a, b) => b - a));
    const wire = JSON.stringify(result);
    for (const leak of [root, "secret-plan", "thread-1", "node_modules", "huge", "my-project", "readme"]) expect(wire).not.toContain(leak);
    expect(lines).toEqual([breakdownLine(result)]);
    expect(lines[0]).toMatch(/^\[storage\] measured in \d+ s: Dogs' work folders 9 MB, /);
    const saved = JSON.parse(readFileSync(join(data, BREAKDOWN_FILE), "utf8")) as DiskBreakdown;
    expect(saved).toEqual(result);
    expect(createDiskBreakdown(deps).last()).toEqual(result);
  });

  it("gives up on a walk that outlives its limit and keeps what it had as incomplete", async () => {
    const { home, data } = tree();
    const runner = createDiskBreakdown({
      dataDir: data, home, scratch: [], dogName: () => null, log: () => {},
      limits: { totalMs: 50, graceMs: 50 },
      walker: () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "ignore"] }),
    });
    expect(runner.measure()).toBe(true);
    const result = (await runner.settled())!;
    expect(result.complete).toBe(false);
    expect(result.entries).toEqual([]);
    expect(runner.measure()).toBe(true);
    await runner.settled();
  });

  it("ignores a saved result that is not a breakdown", () => {
    const { home, data } = tree();
    writeFileSync(join(data, BREAKDOWN_FILE), JSON.stringify({ entries: "nope" }));
    expect(createDiskBreakdown({ dataDir: data, home, scratch: [], dogName: () => null }).last()).toBeNull();
  });
});
