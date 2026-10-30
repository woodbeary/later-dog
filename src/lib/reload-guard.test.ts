import { afterEach, describe, expect, it, vi } from "vitest";
import { holdPageUpdatesWhileHeld, holdReloads, holdReloadsUntil, reloadsHeld, untilReloadsFree } from "./reload-guard";

const releases: Array<() => void> = [];
const hold = () => {
  const release = holdReloads();
  releases.push(release);
  return release;
};
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const watch = (update: Promise<void>) => {
  const seen = { through: false };
  void update.then(() => { seen.through = true; });
  return seen;
};

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await turn();
  vi.restoreAllMocks();
});

describe("holding page updates while the person dictates", () => {
  it("lets an update straight through when nothing holds it", async () => {
    expect(reloadsHeld()).toBe(false);
    const seen = watch(untilReloadsFree());
    await turn();
    expect(seen.through).toBe(true);
  });

  it("waits until every hold is released", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const recording = hold();
    const transcribing = hold();
    const seen = watch(untilReloadsFree());
    recording();
    await turn();
    expect(seen.through).toBe(false);
    expect(reloadsHeld()).toBe(true);
    transcribing();
    await turn();
    expect(seen.through).toBe(true);
    expect(reloadsHeld()).toBe(false);
  });

  it("counts a release only once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const first = hold();
    const second = hold();
    first();
    first();
    expect(reloadsHeld()).toBe(true);
    second();
    expect(reloadsHeld()).toBe(false);
  });

  it("does not let an update through between one hold ending and the next starting in the same moment", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const recording = hold();
    const seen = watch(untilReloadsFree());
    recording();
    const transcribing = hold();
    await turn();
    expect(seen.through).toBe(false);
    transcribing();
    await turn();
    expect(seen.through).toBe(true);
  });

  it("holds while a piece of work runs, and lets go even when it fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let fail: (error: Error) => void = () => {};
    const work = holdReloadsUntil(new Promise<void>((_resolve, reject) => { fail = reject; }));
    expect(reloadsHeld()).toBe(true);
    const seen = watch(untilReloadsFree());
    fail(new Error("offline"));
    await expect(work).rejects.toThrow("offline");
    await turn();
    expect(seen.through).toBe(true);
  });

  it("never holds an update forever", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    hold();
    const seen = watch(untilReloadsFree(5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.through).toBe(true);
  });

  it("waits on the dev server's hot updates, full reloads and restarts", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const listeners = new Map<string, () => Promise<void>>();
    holdPageUpdatesWhileHeld({ on: (event, listener) => { listeners.set(event, listener); } });
    expect([...listeners.keys()]).toEqual(["vite:beforeUpdate", "vite:beforeFullReload", "vite:ws:disconnect"]);
    const release = hold();
    const seen = watch(listeners.get("vite:beforeFullReload")!());
    await turn();
    expect(seen.through).toBe(false);
    release();
    await turn();
    expect(seen.through).toBe(true);
  });

  it("does nothing outside the dev server", () => {
    expect(() => holdPageUpdatesWhileHeld(undefined)).not.toThrow();
  });
});
