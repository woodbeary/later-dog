import { afterEach, describe, expect, it, vi } from "vitest";
import { createMountGuard, MountDown } from "./mount-guard.ts";

const ROOT = "/mnt/dogs";
const never = () => new Promise<never>(() => {});
const fast = (value = "ok") => Promise.resolve(value);

function lagSampler(everyMs = 20) {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - everyMs);
    last = now;
  }, everyMs);
  return { stop: () => { clearInterval(timer); return worst; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("the dog-folder mount guard", () => {
  it("passes paths outside the mounted roots straight through", async () => {
    const guard = createMountGuard({ roots: () => [ROOT] });
    expect(guard.folderOf("/data/config.json")).toBeNull();
    expect(await guard.run("/data/config.json", () => fast("home"))).toBe("home");
  });

  it("keys each dog's folder separately", () => {
    const guard = createMountGuard({ roots: () => [ROOT] });
    expect(guard.folderOf(`${ROOT}/dog-a/memory/MEMORY.md`)).toBe(`${ROOT}/dog-a`);
    expect(guard.folderOf(`${ROOT}/dog-b`)).toBe(`${ROOT}/dog-b`);
  });

  it("marks a folder down after one call that never answers, then fails fast without touching it", async () => {
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 50, coolMs: 10_000 });
    await expect(guard.run(`${ROOT}/stuck/MEMORY.md`, never)).rejects.toBeInstanceOf(MountDown);
    const op = vi.fn(fast);
    const began = performance.now();
    await expect(guard.run(`${ROOT}/stuck/memory/a.md`, op)).rejects.toBeInstanceOf(MountDown);
    expect(performance.now() - began).toBeLessThan(20);
    expect(op).not.toHaveBeenCalled();
    expect(guard.isDown(`${ROOT}/stuck`)).toBe(true);
  });

  it("trips on an I/O error from the folder", async () => {
    const guard = createMountGuard({ roots: () => [ROOT], coolMs: 10_000 });
    await expect(guard.run(`${ROOT}/eio/x`, () => Promise.reject(Object.assign(new Error("io"), { code: "EIO" })))).rejects.toBeInstanceOf(MountDown);
    expect(guard.isDown(`${ROOT}/eio/y`)).toBe(true);
  });

  it("keeps ordinary errors such as a missing file as they are and stays up", async () => {
    const guard = createMountGuard({ roots: () => [ROOT] });
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    await expect(guard.run(`${ROOT}/fine/x`, () => Promise.reject(missing))).rejects.toBe(missing);
    expect(guard.isDown(`${ROOT}/fine`)).toBe(false);
  });

  it("lets one call into a folder at a time and four in all, so stuck folders cannot use up the file-system threads", async () => {
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 200, coolMs: 10_000 });
    let started = 0;
    const stuck = () => { started += 1; return never(); };
    const calls = Array.from({ length: 6 }, () => guard.run(`${ROOT}/busy/f`, stuck).catch((error: unknown) => error));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    const results = await Promise.all(calls);
    expect(results.every((result) => result instanceof MountDown)).toBe(true);
    expect(started).toBe(1);
    const all = createMountGuard({ roots: () => [ROOT], timeoutMs: 100, coolMs: 10_000 });
    let begun = 0;
    const stuckEach = Array.from({ length: 6 }, (_, i) => all.run(`${ROOT}/dog-${i}/f`, () => { begun += 1; return never(); }).catch(() => "down"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(begun).toBe(4);
    await Promise.all(stuckEach);
  });

  it("keeps the home answering and another dog's folder fast while one folder never answers", async () => {
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 300, coolMs: 10_000 });
    const sampler = lagSampler();
    const stuckCalls = Array.from({ length: 20 }, () => guard.run(`${ROOT}/stuck/memory/a.md`, never).catch(() => "down"));
    const began = performance.now();
    const other = await guard.run(`${ROOT}/healthy/MEMORY.md`, () => fast("reply"));
    const otherMs = performance.now() - began;
    await Promise.all(stuckCalls);
    const worstLag = sampler.stop();
    expect(other).toBe("reply");
    expect(otherMs).toBeLessThan(50);
    expect(worstLag).toBeLessThan(300);
  });

  it("probes once after the cool-off and lets calls through again when the folder answers", async () => {
    let now = 0;
    let probes = 0;
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 30, coolMs: 1_000, now: () => now, probe: async () => { probes += 1; } });
    await expect(guard.run(`${ROOT}/back/x`, () => Promise.reject(Object.assign(new Error("io"), { code: "EIO" })))).rejects.toBeInstanceOf(MountDown);
    now = 500;
    await expect(guard.run(`${ROOT}/back/x`, fast)).rejects.toBeInstanceOf(MountDown);
    expect(probes).toBe(0);
    now = 1_500;
    expect(await guard.run(`${ROOT}/back/x`, () => fast("again"))).toBe("again");
    expect(probes).toBe(1);
    expect(guard.isDown(`${ROOT}/back`)).toBe(false);
  });

  it("stays down while an earlier call on the folder has still not returned", async () => {
    let now = 0;
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 30, coolMs: 1_000, now: () => now, probe: fast });
    await expect(guard.run(`${ROOT}/held/x`, never)).rejects.toBeInstanceOf(MountDown);
    now = 1_500;
    await expect(guard.run(`${ROOT}/held/x`, fast)).rejects.toBeInstanceOf(MountDown);
  });

  it("stays down when the probe after the cool-off does not answer", async () => {
    let now = 0;
    const guard = createMountGuard({ roots: () => [ROOT], timeoutMs: 30, coolMs: 1_000, now: () => now, probe: never });
    await expect(guard.run(`${ROOT}/gone/x`, never)).rejects.toBeInstanceOf(MountDown);
    now = 1_500;
    const op = vi.fn(fast);
    await expect(guard.run(`${ROOT}/gone/x`, op)).rejects.toBeInstanceOf(MountDown);
    expect(op).not.toHaveBeenCalled();
  });
});

describe("Claude's working-folder lookup on mounted dog folders", () => {
  it("does not resolve links on a mounted dog folder, so a stuck folder cannot hold the home", async () => {
    const { onMountedDogFolder } = await import("./claude-project.ts");
    const env = { LATERDOG_CLOUD_ROLE: "home", LATERDOG_WORK_FOLDER_LAYOUT: "{}" };
    expect(onMountedDogFolder("/data/.laterdog/task-workspaces/dog/thread", env)).toBe(true);
    expect(onMountedDogFolder("/data/.laterdog/workspaces/dog", env)).toBe(true);
    expect(onMountedDogFolder("/data/.laterdog/accounts/a/.claude", env)).toBe(false);
    expect(onMountedDogFolder("/data/.laterdog/workspaces/dog", {})).toBe(false);
  });
});
