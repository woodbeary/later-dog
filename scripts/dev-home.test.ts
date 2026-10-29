import { describe, expect, it } from "vitest";
import { bucketFor, bundleKey, busyDogs, DEV_BUCKET, HOME_BUCKET, pointerFor, POINTER_KEY, pushOnSave, waitUntilIdle, watchedChange } from "./dev-home.mjs";

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

  it("names the dogs still working", () => {
    expect(busyDogs([{ name: "Clover", busy: true }, { name: "Rio", busy: false }, { busy: true }])).toEqual(["Clover", "a dog"]);
    expect(busyDogs(undefined)).toEqual([]);
  });

  it("switches only once no dog is working, so nobody is cut off mid-task", async () => {
    const answers = [["Clover"], ["Clover"], null, []];
    const lines: string[] = [];
    let waited = 0;
    await waitUntilIdle({ url: "https://h-home.later.dog", token: "t" }, {
      check: async () => { const next = answers.shift(); if (next === null) throw new Error("waking"); return next!; },
      wait: async () => { waited += 1; },
      log: (line: string) => lines.push(line),
    });
    expect(waited).toBe(3);
    expect(lines).toEqual(["waiting for Clover to finish before switching", "waiting for the home to answer before switching"]);
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
