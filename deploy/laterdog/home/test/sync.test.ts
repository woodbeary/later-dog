import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES, collectGarbage, createHttpStore, parseManifest, referencedBlobs, restore, settleWithin, skipped, snapshot, StoreRefused, transient } from "../runtime/sync.mjs";

function memoryStore() {
  const blobs = new Map<string, Uint8Array>();
  const kept = new Map<string, unknown>();
  let manifest: unknown = null;
  const counts = { puts: 0, manifests: 0 };
  return {
    blobs,
    kept,
    counts,
    async manifest() {
      return manifest ? parseManifest(JSON.parse(JSON.stringify(manifest))) : null;
    },
    async putManifest(next: unknown) {
      counts.manifests += 1;
      manifest = next;
    },
    async has(hash: string) {
      return blobs.has(hash);
    },
    async get(hash: string) {
      const bytes = blobs.get(hash);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    },
    async put(hash: string, bytes: Uint8Array) {
      counts.puts += 1;
      blobs.set(hash, new Uint8Array(bytes));
    },
    async listBlobs(cursor?: string) {
      const all = [...blobs.keys()].sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 2);
      return { hashes: page, ...(start + 2 < all.length ? { cursor: String(start + 2) } : {}) };
    },
    async deleteBlob(hash: string) {
      blobs.delete(hash);
    },
    async restorePoints() {
      return [...kept.keys()].sort((left, right) => parseInt(left) - parseInt(right));
    },
    async restorePoint(name: string) {
      if (!kept.has(name)) throw new StoreRefused("restore point read failed: 404", 404);
      return parseManifest(JSON.parse(JSON.stringify(kept.get(name))));
    },
    async putRestorePoint(name: string, point: unknown) {
      kept.set(name, point);
    },
    async deleteRestorePoint(name: string) {
      kept.delete(name);
    },
  };
}

const made: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-home-sync-"));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Entry = { path: string; type: string; mode: number; mtimeMs: number; chunks: string[] };

function chunksFor(manifest: { entries: Entry[] }, path: string): string[] {
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`no entry for ${path}`);
  return entry.chunks;
}

function listing(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .sort()
    .map((path) => {
      const info = statSync(join(root, path));
      return info.isFile() ? `${path} ${info.size} ${info.mtimeMs} ${info.mode}` : `${path}/`;
    });
}

function bytesBesides(root: string, finalName: string): number {
  return readdirSync(root)
    .filter((name) => name !== finalName)
    .reduce((total, name) => total + statSync(join(root, name)).size, 0);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("home data sync", () => {
  it("fetches many files at once on wake, so a large workspace comes back in minutes, and every file still arrives exactly", async () => {
    const source = folder();
    mkdirSync(join(source, "chats"), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(source, "chats", `${i}.json`), `{"chat":${i}}`);
    const store = memoryStore();
    await snapshot(source, store, null, { scratch: folder() });
    let inFlight = 0, most = 0;
    const slow = { ...store, async get(hash: string) {
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return store.get(hash);
    } };
    const target = folder();
    expect((await restore(target, slow, null)).files).toBe(40);
    expect(most).toBeGreaterThan(8);
    for (let i = 0; i < 40; i++) expect(readFileSync(join(target, "chats", `${i}.json`), "utf8")).toBe(`{"chat":${i}}`);
  });

  it("stops every download when one file cannot be read, and only gives up once nothing is still writing", async () => {
    const source = folder();
    mkdirSync(join(source, "chats"), { recursive: true });
    const big = randomBytes(CHUNK_BYTES * 3 + 77);
    writeFileSync(join(source, "chats", "0-big.bin"), big);
    for (let i = 0; i < 60; i++) writeFileSync(join(source, "chats", `${i}.json`), `{"chat":${i}}`);
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const [broken] = chunksFor(saved.manifest, join("chats", "1.json"));
    let reading = 0;
    let gaveUp = false;
    const late: string[] = [];
    const failing = {
      ...store,
      async get(hash: string) {
        if (gaveUp) late.push(hash);
        reading += 1;
        try {
          await pause(hash === broken ? 2 : 15);
          if (hash === broken) throw new Error("blob read failed: 503");
          return await store.get(hash);
        } finally {
          reading -= 1;
        }
      },
    };
    const target = folder();
    let readingWhenGivenUp = -1;
    let leftAtGiveUp: string[] = [];
    const attempt = restore(target, failing, null).finally(() => {
      gaveUp = true;
      readingWhenGivenUp = reading;
      leftAtGiveUp = listing(target);
    });
    await expect(attempt).rejects.toThrow("blob read failed: 503");
    await pause(150);
    expect(readingWhenGivenUp).toBe(0);
    expect(late).toEqual([]);
    expect(listing(target)).toEqual(leftAtGiveUp);
    const files = readdirSync(join(target, "chats"));
    expect(files.filter((name) => !/^\d+\.json$/.test(name))).toEqual([]);
    for (const name of files) expect(readFileSync(join(target, "chats", name), "utf8")).toBe(readFileSync(join(source, "chats", name), "utf8"));
  });

  it("writes a large file chunk by chunk beside it, checking each chunk, and puts it in place only when whole", async () => {
    const source = folder();
    const big = randomBytes(CHUNK_BYTES * 3 + 4321);
    writeFileSync(join(source, "big.bin"), big, { mode: 0o640 });
    utimesSync(join(source, "big.bin"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    expect(chunksFor(saved.manifest, "big.bin")).toHaveLength(4);
    const target = folder();
    const seen: { besides: number; whole: boolean }[] = [];
    const watching = {
      ...store,
      async get(hash: string) {
        seen.push({ besides: bytesBesides(target, "big.bin"), whole: existsSync(join(target, "big.bin")) });
        return store.get(hash);
      },
    };
    const owner = { uid: process.getuid!(), gid: process.getgid!() };
    expect((await restore(target, watching, owner)).files).toBe(1);
    expect(seen).toEqual([0, 1, 2, 3].map((index) => ({ besides: index * CHUNK_BYTES, whole: false })));
    expect(readdirSync(target)).toEqual(["big.bin"]);
    expect(Buffer.compare(readFileSync(join(target, "big.bin")), big)).toBe(0);
    const restored = statSync(join(target, "big.bin"));
    expect(restored.mode & 0o7777).toBe(0o640);
    expect(restored.mtimeMs).toBe(1_700_000_000_000);
    expect(restored.uid).toBe(owner.uid);
  });

  it("keeps the file already there and leaves no partial copy when a chunk does not match its hash", async () => {
    const source = folder();
    writeFileSync(join(source, "big.bin"), randomBytes(CHUNK_BYTES * 2 + 9));
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const [, second] = chunksFor(saved.manifest, "big.bin");
    const tampered = { ...store, async get(hash: string) {
      const bytes = await store.get(hash);
      return hash === second ? bytes.slice(1) : bytes;
    } };
    const target = folder();
    writeFileSync(join(target, "big.bin"), "the copy from last time");
    await expect(restore(target, tampered, null)).rejects.toThrow("corrupt chunk for big.bin");
    expect(readdirSync(target)).toEqual(["big.bin"]);
    expect(readFileSync(join(target, "big.bin"), "utf8")).toBe("the copy from last time");
  });

  it("restores files, folders, links and modes exactly", async () => {
    const source = folder();
    mkdirSync(join(source, ".laterdog", "attachments"), { recursive: true });
    writeFileSync(join(source, ".laterdog", "config.json"), '{"hello":"dog"}');
    writeFileSync(join(source, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    symlinkSync("run.sh", join(source, "latest"));
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    expect(saved.written).toBe(true);

    const target = folder();
    const restored = await restore(target, store, null);
    expect(restored.files).toBe(2);
    expect(readFileSync(join(target, ".laterdog", "config.json"), "utf8")).toBe('{"hello":"dog"}');
    expect(statSync(join(target, "run.sh")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(target, "latest"))).toBe("run.sh");
    expect(statSync(join(target, ".laterdog", "attachments")).isDirectory()).toBe(true);
  });

  it("uploads only what changed and skips caches", async () => {
    const source = folder();
    writeFileSync(join(source, "a.txt"), "first");
    writeFileSync(join(source, "b.txt"), "second");
    mkdirSync(join(source, "project", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(source, "project", "node_modules", "left-pad", "index.js"), "module.exports = 1");
    const store = memoryStore();
    const first = await snapshot(source, store, null, { scratch: folder() });
    expect(store.counts.puts).toBe(2);
    expect(first.manifest.entries.some((entry: { path: string }) => entry.path.includes("node_modules"))).toBe(false);

    const quiet = await snapshot(source, store, first.manifest, { scratch: folder() });
    expect(quiet.written).toBe(false);
    expect(store.counts.puts).toBe(2);

    writeFileSync(join(source, "b.txt"), "second, edited");
    const edited = await snapshot(source, store, quiet.manifest, { scratch: folder() });
    expect(edited.written).toBe(true);
    expect(edited.uploaded).toBe(1);
    expect(store.counts.puts).toBe(3);
  });

  it("keeps saving the rest of the home when one new file cannot be uploaded, and tries it again next time", async () => {
    const source = folder();
    writeFileSync(join(source, "chats.json"), "the chats");
    writeFileSync(join(source, "stuck.bin"), "a piece the store will not take");
    const store = memoryStore();
    const put = store.put.bind(store);
    let refuse = true;
    store.put = async (hash: string, bytes: Uint8Array) => {
      if (refuse && Buffer.from(bytes).toString() === "a piece the store will not take") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return put(hash, bytes);
    };
    const first = await snapshot(source, store, null, { scratch: folder() });
    expect(first.written).toBe(true);
    expect(first.unsaved).toEqual(["stuck.bin"]);
    expect(first.manifest.entries.map((entry: { path: string }) => entry.path)).toEqual(["chats.json"]);
    refuse = false;
    const second = await snapshot(source, store, first.manifest, { scratch: folder() });
    expect(second.unsaved).toEqual([]);
    expect(second.manifest.entries.map((entry: { path: string }) => entry.path).sort()).toEqual(["chats.json", "stuck.bin"]);
  });

  it("never uploads the throwaway .tmp folders engines fill on every start", async () => {
    const source = folder();
    mkdirSync(join(source, ".codex", ".tmp", "plugins", ".git"), { recursive: true });
    writeFileSync(join(source, ".codex", ".tmp", "plugins", ".git", "pack"), "a cloned plugin catalog");
    writeFileSync(join(source, ".codex", "state_5.sqlite.json"), "{}");
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    expect(saved.manifest.entries.some((entry: { path: string }) => entry.path.includes(".tmp"))).toBe(false);
    expect(saved.manifest.entries.some((entry: { path: string }) => entry.path === ".codex/state_5.sqlite.json")).toBe(true);
  });

  it("splits big files into chunks and puts them back together", async () => {
    const source = folder();
    const big = Buffer.alloc(CHUNK_BYTES + 1234, 7);
    big[CHUNK_BYTES + 5] = 9;
    writeFileSync(join(source, "big.bin"), big);
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const entry = saved.manifest.entries.find((candidate: { path: string }) => candidate.path === "big.bin");
    expect(entry.chunks).toHaveLength(2);
    const target = folder();
    await restore(target, store, null);
    expect(Buffer.compare(readFileSync(join(target, "big.bin")), big)).toBe(0);
  });

  it("copies a live database through SQLite's backup, including what is still in the log", async () => {
    const source = folder();
    const path = join(source, "workspace.sqlite");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE dogs (name TEXT); INSERT INTO dogs VALUES ('Biscuit');");
    const store = memoryStore();
    await snapshot(source, store, null, { scratch: folder() });
    database.close();

    const target = folder();
    await restore(target, store, null);
    const copy = new DatabaseSync(join(target, "workspace.sqlite"));
    expect(copy.prepare("SELECT name FROM dogs").all()).toEqual([{ name: "Biscuit" }]);
    copy.close();
  });

  it("refuses a manifest that would write outside the home", () => {
    expect(() => parseManifest({ version: 1, entries: [{ path: "../escape", type: "dir", mode: 0o755, mtimeMs: 1 }] })).toThrow("unsafe");
    expect(() => parseManifest({ version: 1, entries: [{ path: "/etc/passwd", type: "file", chunks: [], mode: 0o644, mtimeMs: 1 }] })).toThrow("unsafe");
  });

  it("skips logs and caches by name", () => {
    expect(skipped("workspace.sqlite-wal")).toBe(true);
    expect(skipped(".cache")).toBe(true);
    expect(skipped(".tmp")).toBe(true);
    expect(skipped("notes.md")).toBe(false);
    expect(skipped(".laterdog-restoring-0123456789abcdef01234567")).toBe(true);
  });

  function signedInHome(): string {
    const home = folder();
    mkdirSync(join(home, ".claude", ".oauth_refresh.lock"), { recursive: true });
    writeFileSync(join(home, ".claude", ".oauth_refresh.lock.owner"), '{"pid":4242}');
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"expiresAt":1}}');
    mkdirSync(join(home, ".claude.lock"));
    const handed = join(home, ".laterdog", "providers", "claude-2");
    mkdirSync(join(handed, ".oauth_refresh.lock"), { recursive: true });
    writeFileSync(join(handed, ".oauth_refresh.lock.owner"), '{"pid":4343}');
    writeFileSync(join(handed, ".credentials.json"), '{"claudeAiOauth":{"expiresAt":2}}');
    mkdirSync(join(home, ".laterdog", "providers", "claude-2.lock"));
    mkdirSync(join(home, "projects", "app"), { recursive: true });
    writeFileSync(join(home, "projects", "app", "yarn.lock"), "# yarn lockfile v1\n");
    writeFileSync(join(home, "projects", "app", "Cargo.lock"), "version = 3\n");
    return home;
  }

  it("never saves a Claude sign-in refresh lock, while keeping the sign-in and project lockfiles", async () => {
    const store = memoryStore();
    const saved = await snapshot(signedInHome(), store, null, { scratch: folder() });
    const paths = saved.manifest.entries.map((entry: { path: string }) => entry.path);
    expect(paths.filter((path: string) => /oauth_refresh|claude\.lock|claude-2\.lock/.test(path))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining([
      join(".claude", ".credentials.json"),
      join(".laterdog", "providers", "claude-2", ".credentials.json"),
      join("projects", "app", "yarn.lock"),
      join("projects", "app", "Cargo.lock"),
    ]));
  });

  it("drops refresh locks an older save still holds, so a woken home starts with none", async () => {
    const store = memoryStore();
    const home = folder();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"expiresAt":1}}');
    const saved = await snapshot(home, store, null, { scratch: folder() });
    const credentials = saved.manifest.entries.find((entry: { path: string }) => entry.path === join(".claude", ".credentials.json"));
    const held = Date.now() - 5_000;
    await store.putManifest({ ...saved.manifest, entries: [
      ...saved.manifest.entries,
      { path: join(".claude", ".oauth_refresh.lock"), type: "dir", mode: 0o755, mtimeMs: held },
      { path: join(".claude", ".oauth_refresh.lock.owner"), type: "file", mode: 0o600, mtimeMs: held, size: credentials.size, chunks: credentials.chunks },
      { path: ".claude.lock", type: "dir", mode: 0o755, mtimeMs: held },
    ] });

    const woken = folder();
    const restored = await restore(woken, store, null);
    expect(readFileSync(join(woken, ".claude", ".credentials.json"), "utf8")).toBe('{"claudeAiOauth":{"expiresAt":1}}');
    expect(existsSync(join(woken, ".claude", ".oauth_refresh.lock"))).toBe(false);
    expect(existsSync(join(woken, ".claude", ".oauth_refresh.lock.owner"))).toBe(false);
    expect(existsSync(join(woken, ".claude.lock"))).toBe(false);

    const next = await snapshot(woken, store, restored.manifest, { scratch: folder() });
    expect(next.written).toBe(true);
    expect((await store.manifest())!.entries.map((entry: { path: string }) => entry.path)).toEqual([".claude", join(".claude", ".credentials.json")]);
  });

  it("treats only lock folders as held locks, never lockfiles a project keeps", () => {
    expect(transient({ path: ".claude/.oauth_refresh.lock", type: "dir" })).toBe(true);
    expect(transient({ path: ".claude/.oauth_refresh.lock.owner", type: "file" })).toBe(true);
    expect(transient({ path: ".claude.lock", type: "dir" })).toBe(true);
    expect(transient({ path: "projects/app/yarn.lock", type: "file" })).toBe(false);
    expect(transient({ path: ".claude/.credentials.json", type: "file" })).toBe(false);
  });
});

describe("reading saved pieces over HTTP", () => {
  function stalling(signals: AbortSignal[]) {
    return (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) as unknown as typeof fetch;
  }

  it("gives up on a blob read that stalls instead of holding a download slot for minutes", async () => {
    const signals: AbortSignal[] = [];
    const store = createHttpStore("https://state.invalid/home", "test-token", stalling(signals), { blobTimeoutMs: 40 });
    const started = Date.now();
    await expect(store.get("a".repeat(64))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signals).toHaveLength(1);
  });

  it("gives up on an upload that stalls, so one stuck piece never blocks every later save", async () => {
    const signals: AbortSignal[] = [];
    const store = createHttpStore("https://state.invalid/home", "test-token", stalling(signals), { uploadTimeoutMs: 40 });
    const started = Date.now();
    await expect(store.put("d".repeat(64), new Uint8Array(8))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on every other call to the store that stalls", async () => {
    const store = createHttpStore("https://state.invalid/home", "test-token", stalling([]), { requestTimeoutMs: 40 });
    await expect(store.putManifest({ version: 1, createdAt: 1, entries: [] })).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(store.has("e".repeat(64))).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(store.manifest()).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(store.listBlobs()).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(store.deleteBlob("f".repeat(64))).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("stops waiting for the last save at its deadline, so a stopping home always lets go", async () => {
    await expect(settleWithin(new Promise(() => {}), 30)).resolves.toBe("late");
    await expect(settleWithin(Promise.resolve(), 1_000)).resolves.toBe("done");
    await expect(settleWithin(Promise.reject(new Error("save failed")), 1_000)).resolves.toBe("failed");
  });

  it("drops a blob read at once when the restore that asked for it stops", async () => {
    const store = createHttpStore("https://state.invalid/home", "test-token", stalling([]));
    const stop = new AbortController();
    const reading = store.get("b".repeat(64), { signal: stop.signal });
    stop.abort(new Error("restore stopped"));
    await expect(reading).rejects.toThrow("restore stopped");
  });

  it("reads a blob within the time limit as before", async () => {
    const bytes = randomBytes(64);
    const seen: { url: string; signal: unknown }[] = [];
    const answering = (async (url: string, init: RequestInit) => {
      seen.push({ url, signal: init.signal });
      return new Response(bytes);
    }) as unknown as typeof fetch;
    const store = createHttpStore("https://state.invalid/home/", "test-token", answering);
    expect(Buffer.from(await store.get("c".repeat(64))).equals(bytes)).toBe(true);
    expect(seen[0].url).toBe(`https://state.invalid/home/blobs/${"c".repeat(64)}`);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("cleaning up saved pieces", () => {
  it("removes pieces no file uses any more and keeps every piece the latest save needs", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "notes.md"), "first");
    writeFileSync(join(home, "big.bin"), Buffer.alloc(CHUNK_BYTES + 10, 1));
    const first = await snapshot(home, store, null);
    writeFileSync(join(home, "notes.md"), "second, longer");
    writeFileSync(join(home, "big.bin"), Buffer.alloc(CHUNK_BYTES + 10, 2), { flag: "w" });
    const second = await snapshot(home, store, first.manifest);
    const before = store.blobs.size;
    const removed = await collectGarbage(store, second.manifest);
    expect(removed).toBeGreaterThan(0);
    expect(store.blobs.size).toBe(before - removed);
    expect(new Set(store.blobs.keys())).toEqual(referencedBlobs(second.manifest));
    const restoredTo = folder();
    await restore(restoredTo, store);
    expect(readFileSync(join(restoredTo, "notes.md"), "utf8")).toBe("second, longer");
    expect(readFileSync(join(restoredTo, "big.bin")).equals(Buffer.alloc(CHUNK_BYTES + 10, 2))).toBe(true);
  });

  it("does nothing without a saved home, and a later save re-uploads anything it needs", async () => {
    const store = memoryStore();
    expect(await collectGarbage(store, null)).toBe(0);
    const home = folder();
    writeFileSync(join(home, "a.txt"), "alpha");
    const saved = await snapshot(home, store, null);
    await collectGarbage(store, { version: 1, createdAt: 0, entries: [] });
    expect(store.blobs.size).toBe(0);
    writeFileSync(join(home, "a.txt"), "alpha again");
    const again = await snapshot(home, store, saved.manifest);
    expect(store.blobs.size).toBe(referencedBlobs(again.manifest).size);
  });
});

describe("keeping restore points safe from cleanup", () => {
  it("stamps each save with the app that wrote it, and saves again when only the app changed", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "bots.json"), "[]");
    const first = await snapshot(home, store, null, { app: "0.3.42+81e55420b249" });
    expect(first.manifest.app).toBe("0.3.42+81e55420b249");
    const unchanged = await snapshot(home, store, first.manifest, { app: "0.3.42+81e55420b249" });
    expect(unchanged.written).toBe(false);
    const upgraded = await snapshot(home, store, first.manifest, { app: "0.3.43+5e1f00c0ffee" });
    expect(upgraded.written).toBe(true);
    expect(upgraded.uploaded).toBe(0);
    expect(upgraded.manifest.app).toBe("0.3.43+5e1f00c0ffee");
    expect((await snapshot(home, store, null)).manifest).not.toHaveProperty("app");
  });

  it("keeps every piece a kept or still-waiting restore point needs, and drops the rest", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "bots.json"), "before the upgrade");
    writeFileSync(join(home, "notes.md"), "first notes");
    const kept = await snapshot(home, store, null, { app: "0.3.41" });
    store.kept.set(`${kept.manifest.createdAt}.json`, kept.manifest);
    writeFileSync(join(home, "bots.json"), "after the upgrade, migrated");
    const waiting = await snapshot(home, store, kept.manifest, { app: "0.3.42" });
    writeFileSync(join(home, "bots.json"), "changed again since");
    writeFileSync(join(home, "notes.md"), "notes written later");
    const latest = await snapshot(home, store, waiting.manifest, { app: "0.3.42" });
    const removed = await collectGarbage(store, latest.manifest, { pending: [waiting.manifest] });
    const needed = new Set([...referencedBlobs(kept.manifest), ...referencedBlobs(waiting.manifest), ...referencedBlobs(latest.manifest)]);
    expect(removed).toBe(0);
    expect(new Set(store.blobs.keys())).toEqual(needed);
    expect(await collectGarbage(store, latest.manifest)).toBe(1);
    expect(new Set(store.blobs.keys())).toEqual(new Set([...referencedBlobs(kept.manifest), ...referencedBlobs(latest.manifest)]));
    await store.putManifest(kept.manifest);
    const rolledBack = folder();
    await restore(rolledBack, store);
    expect(readFileSync(join(rolledBack, "bots.json"), "utf8")).toBe("before the upgrade");
    expect(readFileSync(join(rolledBack, "notes.md"), "utf8")).toBe("first notes");
  });

  it("removes nothing when the restore points cannot be read, so a kept restore point never loses a piece", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "a.txt"), "alpha");
    const saved = await snapshot(home, store, null);
    const unreadable = { ...store, restorePoints: async () => { throw new StoreRefused("restore point list failed: 400", 400); } };
    await expect(collectGarbage(unreadable, { version: 1, createdAt: 0, entries: [] })).rejects.toThrow("restore point list failed: 400");
    expect(store.blobs.size).toBe(referencedBlobs(saved.manifest).size);
    store.kept.set("5.json", saved.manifest);
    const lost = { ...store, restorePoint: async () => { throw new StoreRefused("restore point read failed: 500", 500); } };
    await expect(collectGarbage(lost, { version: 1, createdAt: 0, entries: [] })).rejects.toThrow("restore point read failed: 500");
    expect(store.blobs.size).toBe(referencedBlobs(saved.manifest).size);
  });

  it("reads, writes, lists and deletes restore points over HTTP, oldest first, and says why the store refused", async () => {
    const seen: string[] = [];
    const answering = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/restore-points/")) return Response.json({ names: ["1760000000000.json", "999.json", "../manifest.json", "1700000000000.json"] });
      if (url.endsWith("/restore-points/1.json") && (init.method ?? "GET") === "GET") return Response.json({ version: 1, createdAt: 1, entries: [] });
      if (url.endsWith("/restore-points/2.json")) return new Response("Invalid state key", { status: 400 });
      return new Response(null, { status: init.method === "DELETE" ? 204 : 201 });
    }) as unknown as typeof fetch;
    const store = createHttpStore("https://state.invalid/home", "test-token", answering);
    expect(await store.restorePoints()).toEqual(["999.json", "1700000000000.json", "1760000000000.json"]);
    expect(await store.restorePoint("1.json")).toEqual({ version: 1, createdAt: 1, entries: [] });
    await store.putRestorePoint("1.json", { version: 1, createdAt: 1, entries: [] });
    await store.deleteRestorePoint("1.json");
    await expect(store.putRestorePoint("2.json", { version: 1, createdAt: 2, entries: [] })).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual([
      "GET https://state.invalid/home/restore-points/",
      "GET https://state.invalid/home/restore-points/1.json",
      "PUT https://state.invalid/home/restore-points/1.json",
      "DELETE https://state.invalid/home/restore-points/1.json",
      "PUT https://state.invalid/home/restore-points/2.json",
    ]);
  });
});
