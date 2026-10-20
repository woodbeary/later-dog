import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRelease, keepRestorePoint, pruneRestorePoints, restorePointName, storeLacksRestorePoints, upgradeFrom, upgradeKeeper } from "../runtime/restore-points.mjs";
import { collectGarbage, createHttpStore, referencedBlobs, restore, snapshot, StoreRefused } from "../runtime/sync.mjs";
import { handleState, type StateBucket } from "../src/state.ts";

const CONTAINER = "a".repeat(64);

const made: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-restore-points-"));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function memoryBucket(): StateBucket & { objects: Map<string, ArrayBuffer> } {
  const objects = new Map<string, ArrayBuffer>();
  return {
    objects,
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: new Response(value).body as ReadableStream, httpEtag: '"etag"' } : null;
    },
    async put(key, value) {
      objects.set(key, value);
      return {};
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

function workerStore(bucket: StateBucket) {
  const fetcher = (async (url: string, init?: RequestInit) => handleState(new Request(url, init), bucket, CONTAINER)) as unknown as typeof fetch;
  return createHttpStore("http://state.r2", "test-token", fetcher);
}

function oldWorkerStore(bucket: StateBucket) {
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.startsWith("/restore-points/")) return new Response("Invalid state key", { status: 400 });
    return handleState(new Request(url, init), bucket, CONTAINER);
  }) as unknown as typeof fetch;
  return createHttpStore("http://state.r2", "test-token", fetcher);
}

function release(files: Record<string, string>): string {
  const root = folder();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("telling one app build from another", () => {
  it("names the build from the image's package version and the commit it was built from", () => {
    expect(appRelease(release({ "package.json": JSON.stringify({ version: "0.3.43" }), build: "5e1f00c0ffee1234567890\n" }))).toBe("0.3.43+5e1f00c0ffee");
    expect(appRelease(release({ "package.json": JSON.stringify({ version: "0.3.43" }) }))).toBe("0.3.43");
    expect(appRelease(release({ build: "5e1f00c0ffee1234567890" }))).toBe("5e1f00c0ffee");
    expect(appRelease(release({ "package.json": "not json" }))).toBeNull();
    expect(appRelease(folder())).toBeNull();
  });

  it("sees an upgrade only when a saved home was written by a different build", () => {
    const saved = { version: 1, createdAt: 1, app: "0.3.42+81e55420b249", entries: [] };
    expect(upgradeFrom(saved, "0.3.42+81e55420b249")).toBeNull();
    expect(upgradeFrom(saved, "0.3.43+5e1f00c0ffee")).toBe(saved);
    expect(upgradeFrom(saved, "0.3.42+0d15ea5e0000")).toBe(saved);
    expect(upgradeFrom({ version: 1, createdAt: 1, entries: [] }, "0.3.43")).toEqual({ version: 1, createdAt: 1, entries: [] });
    expect(upgradeFrom(null, "0.3.43")).toBeNull();
    expect(upgradeFrom(saved, null)).toBeNull();
  });

  it("names a restore point after the save it keeps", () => {
    expect(restorePointName({ createdAt: 1760900000123.7 })).toBe("1760900000123.json");
    expect(restorePointName({})).toBe("0.json");
  });
});

describe("restore points on upgrade, through the home Worker's state store", () => {
  it("keeps the earlier build's save before the first save of the new one, and it restores that home exactly", async () => {
    const bucket = memoryBucket();
    const store = workerStore(bucket);
    const home = folder();
    writeFileSync(join(home, "bots.json"), JSON.stringify([{ id: "dog", threadId: "long-conversation" }]));
    writeFileSync(join(home, "notes.md"), "written on 0.3.42");
    const before = await snapshot(home, store, null, { app: "0.3.42+81e55420b249", now: () => 1_760_900_000_000 });

    const woken = folder();
    const restored = await restore(woken, store);
    const upgraded = upgradeFrom(restored.manifest, "0.3.43+5e1f00c0ffee");
    expect(upgraded).not.toBeNull();
    const logs: string[] = [];
    const keeper = upgradeKeeper(store, upgraded, { app: "0.3.43+5e1f00c0ffee", log: (line: string) => logs.push(line), now: () => 1_760_990_000_000 });
    await keeper.keep();
    writeFileSync(join(woken, "bots.json"), JSON.stringify([{ id: "dog", threadId: "an empty thread" }]));
    const after = await snapshot(woken, store, restored.manifest, { app: "0.3.43+5e1f00c0ffee", now: () => 1_760_990_000_500 });

    expect(logs).toEqual(["kept restore point 1760900000000.json"]);
    expect(keeper.pending()).toEqual([]);
    expect(await store.restorePoints()).toEqual(["1760900000000.json"]);
    const point = await store.restorePoint("1760900000000.json");
    expect(point).toMatchObject({ app: "0.3.42+81e55420b249", replacedBy: "0.3.43+5e1f00c0ffee", keptAt: 1_760_990_000_000, entries: before.manifest.entries });
    expect((await store.manifest())?.app).toBe("0.3.43+5e1f00c0ffee");

    await collectGarbage(store, after.manifest);
    expect(new Set([...bucket.objects.keys()].filter((key) => key.includes("/blobs/")).map((key) => key.split("/").at(-1))))
      .toEqual(new Set([...referencedBlobs(before.manifest), ...referencedBlobs(after.manifest)]));

    await store.putManifest(point);
    const rolledBack = folder();
    await restore(rolledBack, store);
    expect(JSON.parse(readFileSync(join(rolledBack, "bots.json"), "utf8"))).toEqual([{ id: "dog", threadId: "long-conversation" }]);
    expect(readFileSync(join(rolledBack, "notes.md"), "utf8")).toBe("written on 0.3.42");
  });

  it("keeps only the newest restore points, and cleanup then lets go of what only the dropped ones used", async () => {
    const bucket = memoryBucket();
    const store = workerStore(bucket);
    const home = folder();
    let manifest = null;
    const saves = [];
    for (const [index, app] of ["0.3.40", "0.3.41", "0.3.42", "0.3.43", "0.3.44"].entries()) {
      writeFileSync(join(home, "bots.json"), `written by ${app}`);
      if (manifest) await upgradeKeeper(store, upgradeFrom(manifest, app), { app, limit: 3 }).keep();
      manifest = (await snapshot(home, store, manifest, { app, now: () => 1_000 + index })).manifest;
      saves.push(manifest);
    }
    expect(await store.restorePoints()).toEqual(["1001.json", "1002.json", "1003.json"]);
    await collectGarbage(store, manifest);
    const blobs = new Set([...bucket.objects.keys()].filter((key) => key.includes("/blobs/")).map((key) => key.split("/").at(-1)));
    expect(blobs).toEqual(new Set(saves.slice(1).flatMap((save) => [...referencedBlobs(save)])));
    expect([...referencedBlobs(saves[0])].some((hash) => blobs.has(hash))).toBe(false);
    expect(await pruneRestorePoints(store, { limit: 0 })).toEqual(["1001.json", "1002.json"]);
    expect(await store.restorePoints()).toEqual(["1003.json"]);
  });

  it("does not keep a restore point when the same build wakes again", async () => {
    const bucket = memoryBucket();
    const store = workerStore(bucket);
    const home = folder();
    writeFileSync(join(home, "a.txt"), "alpha");
    const saved = await snapshot(home, store, null, { app: "0.3.43+5e1f00c0ffee" });
    const restored = await restore(folder(), store);
    const keeper = upgradeKeeper(store, upgradeFrom(restored.manifest, "0.3.43+5e1f00c0ffee"), { app: "0.3.43+5e1f00c0ffee" });
    await keeper.keep();
    expect(await store.restorePoints()).toEqual([]);
    expect(restored.manifest).toEqual(saved.manifest);
  });

  it("tries again before the next save when the store fails for a moment, and keeps what that restore point needs meanwhile", async () => {
    const bucket = memoryBucket();
    const reliable = workerStore(bucket);
    const home = folder();
    writeFileSync(join(home, "bots.json"), "before");
    const before = await snapshot(home, reliable, null, { app: "0.3.42" });
    let failures = 1;
    const flaky = {
      ...reliable,
      async putRestorePoint(name: string, kept: unknown) {
        if (failures-- > 0) throw new StoreRefused("restore point write failed: 503", 503);
        return reliable.putRestorePoint(name, kept);
      },
    };
    const logs: string[] = [];
    const keeper = upgradeKeeper(flaky, before.manifest, { app: "0.3.43", log: (line: string) => logs.push(line) });
    await keeper.keep();
    expect(keeper.pending()).toEqual([before.manifest]);
    writeFileSync(join(home, "bots.json"), "after");
    const after = await snapshot(home, reliable, before.manifest, { app: "0.3.43" });
    await collectGarbage(reliable, after.manifest, { pending: keeper.pending() });
    expect([...referencedBlobs(before.manifest)].every((hash) => bucket.objects.has(`homes/${CONTAINER}/blobs/${hash}`))).toBe(true);
    await keeper.keep();
    expect(keeper.pending()).toEqual([]);
    expect(await reliable.restorePoints()).toEqual([`${before.manifest.createdAt}.json`]);
    expect(logs).toEqual([
      "could not keep the restore point yet: restore point write failed: 503; trying again before the next save",
      `kept restore point ${before.manifest.createdAt}.json`,
    ]);
  });

  it("stops asking a store that predates restore points, and cleanup there removes nothing", async () => {
    const bucket = memoryBucket();
    const store = oldWorkerStore(bucket);
    const home = folder();
    writeFileSync(join(home, "bots.json"), "before");
    const before = await snapshot(home, store, null, { app: "0.3.42" });
    const logs: string[] = [];
    const keeper = upgradeKeeper(store, before.manifest, { app: "0.3.43", log: (line: string) => logs.push(line) });
    await keeper.keep();
    expect(keeper.pending()).toEqual([]);
    expect(logs).toEqual(["this home's state store does not keep restore points yet"]);
    writeFileSync(join(home, "bots.json"), "after");
    const after = await snapshot(home, store, before.manifest, { app: "0.3.43" });
    await expect(collectGarbage(store, after.manifest)).rejects.toMatchObject({ status: 400 });
    expect([...referencedBlobs(before.manifest)].every((hash) => bucket.objects.has(`homes/${CONTAINER}/blobs/${hash}`))).toBe(true);
  });

  it("still keeps the restore point when removing older ones fails, and says so", async () => {
    const bucket = memoryBucket();
    const reliable = workerStore(bucket);
    const logs: string[] = [];
    const store = { ...reliable, restorePoints: async () => { throw new StoreRefused("restore point list failed: 500", 500); } };
    await upgradeKeeper(store, { version: 1, createdAt: 7, entries: [] }, { app: "0.3.43", log: (line: string) => logs.push(line) }).keep();
    expect(await reliable.restorePoints()).toEqual(["7.json"]);
    expect(logs).toEqual(["kept restore point 7.json", "could not remove older restore points: restore point list failed: 500"]);
  });

  it("treats only a refusal of the restore point itself as a store without restore points", () => {
    expect(storeLacksRestorePoints(new StoreRefused("restore point write failed: 400", 400))).toBe(true);
    expect(storeLacksRestorePoints(new StoreRefused("restore point write failed: 503", 503))).toBe(false);
    expect(storeLacksRestorePoints(new Error("network down"))).toBe(false);
  });

  it("stores a restore point with the build that replaced it", async () => {
    const puts: Array<[string, unknown]> = [];
    const name = await keepRestorePoint({ putRestorePoint: async (key: string, value: unknown) => { puts.push([key, value]); } },
      { version: 1, createdAt: 42, app: "0.3.42", entries: [] }, { app: "0.3.43", now: () => 99 });
    expect(name).toBe("42.json");
    expect(puts).toEqual([["42.json", { version: 1, createdAt: 42, app: "0.3.42", keptAt: 99, replacedBy: "0.3.43", entries: [] }]]);
  });
});
