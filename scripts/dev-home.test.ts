import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEV_CODE_MAX_WAIT_MS } from "../deploy/laterdog/home/runtime/dev-code.mjs";
import { bucketFor, bundleKey, confirmSwitch, DEV_BUCKET, HOME_BUCKET, pointerFor, POINTER_KEY, pushOnSave, READY_AFTER_DRAIN_MS, READY_TIMEOUT_MS, waitForNewServer, watchedChange } from "./dev-home.mjs";

describe("pushing server code to test homes", () => {
  it("writes only to the test bucket, under the keys test homes read", () => {
    expect(DEV_BUCKET).toBe("laterdog-homes-test");
    expect(POINTER_KEY).toBe("dev-code/current.json");
    expect(bundleKey("a".repeat(64))).toBe(`dev-code/${"a".repeat(64)}.tgz`);
  });

  it("names each push by what it holds and when", () => {
    expect(pointerFor("c".repeat(64), "6259f1c+local", new Date("2026-10-23T23:00:00Z"))).toEqual({
      hash: "c".repeat(64), label: "6259f1c+local", at: "2026-10-23T23:00:00.000Z",
    });
  });

  it("pushes on server source changes, not on tests or installed packages", () => {
    expect(watchedChange("laterdog/shared-join.ts")).toBe(true);
    expect(watchedChange("model-catalog/models-dev.snapshot.json")).toBe(true);
    expect(watchedChange("laterdog/shared-join.test.ts")).toBe(false);
    expect(watchedChange("node_modules/x/index.ts")).toBe(false);
    expect(watchedChange("notes.md")).toBe(false);
    expect(watchedChange(null)).toBe(false);
  });
});

describe("pushing server code from later.dog Dev to the person's own home", () => {
  it("writes a test home's code to the test bucket and a real home's to the homes bucket", () => {
    expect(bucketFor("https://hdd7dd0f8e579ef57f10290f4-hometest.later.dog")).toBe(DEV_BUCKET);
    expect(bucketFor("https://he6e3bd4d404f3dfb6be1a40b-home.later.dog/")).toBe(HOME_BUCKET);
    expect(HOME_BUCKET).toBe("laterdog-homes");
  });

  it("publishes the pointer without waiting for dogs to stop, leaving the drain to the home runtime", () => {
    const source = readFileSync(new URL("./dev-home.mjs", import.meta.url), "utf8");
    const publishBody = source.slice(source.indexOf("export async function publish"), source.indexOf("export async function confirmSwitch"));
    expect(source).not.toMatch(/waitUntilIdle|busyNow|api\/bots/);
    expect(publishBody.indexOf("POINTER_KEY")).toBeGreaterThan(-1);
    expect(publishBody).not.toMatch(/\b(?:wait\w*|idle|busy)/i);
  });

  it("allows the runtime's full drain plus the restart before calling a switch late, from the runtime's own constant", () => {
    const source = readFileSync(new URL("./dev-home.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\d\s*\*\s*60_000/);
    expect(DEV_CODE_MAX_WAIT_MS).toBe(15 * 60_000);
    expect(READY_TIMEOUT_MS).toBe(DEV_CODE_MAX_WAIT_MS + READY_AFTER_DRAIN_MS);
  });

  it("measures the wait from the moment the pointer was published, so an earlier delay cannot expire it", async () => {
    let clock = 20 * 60_000;
    const pids = [10, 10, 10, 11];
    const pid = await waitForNewServer({ read: async () => pids.shift()!, before: 10, since: clock, now: () => clock, wait: async (ms: number) => { clock += ms; }, everyMs: 60_000 });
    expect(pid).toBe(11);
    expect(clock).toBe(20 * 60_000 + 3 * 60_000);
  });

  it("gives up only after the drain and restart window has passed since publishing", async () => {
    let clock = 0;
    const pid = await waitForNewServer({ read: async () => 10, before: 10, since: 0, now: () => clock, wait: async (ms: number) => { clock += ms; }, everyMs: 30_000 });
    expect(pid).toBeNull();
    expect(clock).toBe(READY_TIMEOUT_MS);
  });

  it("does not claim a switch when the home was not answering before the push or still reports the old server", async () => {
    const lines: string[] = [];
    const home = { url: "https://h-home.later.dog", token: "t" };
    const unknown = await confirmSwitch({ hash: "h", home, before: null, published: 0, who: "h" }, { read: async () => 7, log: (l: string) => lines.push(l) });
    expect(unknown).toEqual({ hash: "h" });
    let clock = 0;
    const stale = await confirmSwitch({ hash: "h", home, before: 7, published: 0, who: "h" }, { read: async () => 7, log: (l: string) => lines.push(l), now: () => clock, wait: async (ms: number) => { clock += ms; }, everyMs: 60_000 });
    expect(stale).toEqual({ hash: "h" });
    expect(lines.join("\n")).not.toContain("server pid changed");
    expect(lines[1]).toContain("switch not confirmed")
    expect(lines.join("\n")).not.toContain("old server")
    const silent: string[] = [];
    let tick = 0;
    await confirmSwitch({ hash: "h", home, before: 7, published: 0, who: "h" }, { read: async () => null, log: (l: string) => silent.push(l), now: () => tick, wait: async (ms: number) => { tick += ms; }, everyMs: 60_000 });
    expect(silent).toHaveLength(1);
    expect(silent[0]).toContain("switch not confirmed");
    expect(silent[0]).not.toContain("old server");;
  });

  it("reports the new server only after its pid differs from the one before the push", async () => {
    const lines: string[] = [];
    const home = { url: "https://h-home.later.dog", token: "t" };
    const result = await confirmSwitch({ hash: "h", home, before: 7, published: 0, who: "h" }, { read: async () => 8, log: (l: string) => lines.push(l), now: () => 5_000 });
    expect(result).toEqual({ hash: "h", pid: 8 });
    expect(lines).toEqual(["h server pid changed to 8 5 s after the push; that this exact code (h) is the one running needs separate qualification"]);
    expect(lines.join("\n")).not.toMatch(/running it|is running/);
  });

  it("stops without reporting success when cancelled", async () => {
    const lines: string[] = [];
    const home = { url: "https://h-home.later.dog", token: "t" };
    const controller = new AbortController();
    const waiting = confirmSwitch({ hash: "h", home, before: 7, published: Date.now(), who: "h" }, { read: async () => 7, log: (l: string) => lines.push(l), signal: controller.signal, everyMs: 60_000 });
    controller.abort();
    await expect(waiting).rejects.toThrow("stopped");
    expect(lines).toEqual([]);
  });

  it("does not report a changed pid when cancelled during the read", async () => {
    const lines: string[] = [];
    const home = { url: "https://h-home.later.dog", token: "t" };
    const controller = new AbortController();
    let release: (pid: number) => void = () => {};
    const waiting = confirmSwitch({ hash: "h", home, before: 7, published: Date.now(), who: "h" }, { read: () => new Promise<number>((resolve) => { release = resolve; }), log: (l: string) => lines.push(l), signal: controller.signal });
    controller.abort();
    release(8);
    await expect(waiting).rejects.toThrow("stopped");
    expect(lines).toEqual([]);
  });

  it("stops before reading when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const home = { url: "https://h-home.later.dog", token: "t" };
    await expect(confirmSwitch({ hash: "h", home, before: 7, published: Date.now(), who: "h" }, { read: async () => 8, log: () => {}, signal: controller.signal })).rejects.toThrow("stopped");
  });

  it("surfaces a failing read instead of reporting success", async () => {
    const home = { url: "https://h-home.later.dog", token: "t" };
    await expect(confirmSwitch({ hash: "h", home, before: 7, published: Date.now(), who: "h" }, { read: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
  });

  it("folds saves made during a push into one more push", async () => {
    let pushes = 0;
    let release = () => {};
    const pushNow = () => new Promise<void>((resolve) => { pushes += 1; release = resolve; });
    const save = pushOnSave(pushNow, { settleMs: 0, log: () => {} });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    save();
    await tick();
    expect(pushes).toBe(1);
    save(); await tick(); save(); await tick(); save(); await tick();
    expect(pushes).toBe(1);
    release();
    await tick();
    expect(pushes).toBe(2);
    release();
    await tick();
    expect(pushes).toBe(2);
  });
});
