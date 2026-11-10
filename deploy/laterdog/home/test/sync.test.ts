import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES, CLEANUP_PARALLEL, collectGarbage, collectGarbageWithin, createHttpStore, parseManifest, referencedBlobs, restore, resumeOrder, SAVE_PARALLEL, settleWithin, skipped, skippedPath, snapshot, walkOrder, SNAPSHOT_RESERVE_BYTES, StoreRefused, transient } from "../runtime/sync.mjs";

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
    const attempt = restore(target, failing, null, { chunkAttempts: 1 }).finally(() => {
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

  it("reads a piece again when the network drops it, so one dropped read never throws away a whole wake", async () => {
    const source = folder();
    for (let i = 0; i < 30; i++) writeFileSync(join(source, `${i}.json`), `{"chat":${i}}`);
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const [flaky] = chunksFor(saved.manifest, "7.json");
    let drops = 0;
    const dropping = { ...store, async get(hash: string) {
      if (hash === flaky && drops < 3) {
        drops += 1;
        throw new TypeError("fetch failed");
      }
      return store.get(hash);
    } };
    const target = folder();
    expect((await restore(target, dropping, null, { chunkRetryMs: 1 })).files).toBe(30);
    expect(drops).toBe(3);
    for (let i = 0; i < 30; i++) expect(readFileSync(join(target, `${i}.json`), "utf8")).toBe(`{"chat":${i}}`);
  });

  it("keeps what an earlier try already put back, and fetches only what is still missing", async () => {
    const source = folder();
    for (let i = 0; i < 30; i++) writeFileSync(join(source, `${i}.json`), `{"chat":${i}}`);
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const [broken] = chunksFor(saved.manifest, "29.json");
    const target = folder();
    const failing = { ...store, async get(hash: string) {
      if (hash === broken) throw new TypeError("fetch failed");
      return store.get(hash);
    } };
    const finished = new Set<string>();
    await expect(restore(target, failing, null, { chunkAttempts: 1, finished })).rejects.toThrow("fetch failed");
    const before = readdirSync(target).filter((name) => name.endsWith(".json")).length;
    expect(before).toBeGreaterThan(0);
    let reads = 0;
    const counting = { ...store, async get(hash: string) {
      reads += 1;
      return store.get(hash);
    } };
    expect((await restore(target, counting, null, { finished })).files).toBe(30);
    expect(reads).toBe(30 - before);
    for (let i = 0; i < 30; i++) expect(readFileSync(join(target, `${i}.json`), "utf8")).toBe(`{"chat":${i}}`);
  });

  it("fetches a file again when the copy on disk differs from the save", async () => {
    const source = folder();
    writeFileSync(join(source, "note.txt"), "saved words");
    utimesSync(join(source, "note.txt"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const store = memoryStore();
    await snapshot(source, store, null, { scratch: folder() });
    const target = folder();
    writeFileSync(join(target, "note.txt"), "other words");
    utimesSync(join(target, "note.txt"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await restore(target, store, null);
    expect(readFileSync(join(target, "note.txt"), "utf8")).toBe("saved words");
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

  it("never saves pnpm's package store, which one install fills with tens of thousands of files", async () => {
    const source = folder();
    mkdirSync(join(source, ".local", "share", "pnpm", "store", "v10", "files", "00"), { recursive: true });
    writeFileSync(join(source, ".local", "share", "pnpm", "store", "v10", "files", "00", "a1b2"), "a package file");
    mkdirSync(join(source, ".local", "share", "notes"), { recursive: true });
    writeFileSync(join(source, ".local", "share", "notes", "keep.md"), "kept");
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch: folder() });
    const paths = saved.manifest.entries.map((entry: { path: string }) => entry.path);
    expect(paths).toContain(".local/share/notes/keep.md");
    expect(paths.some((path: string) => path.startsWith(".local/share/pnpm"))).toBe(false);
    expect(skippedPath(".local/share/pnpm")).toBe(true);
    expect(skippedPath(".local/share/pnpm-notes")).toBe(false);
    expect(transient({ path: ".local/share/pnpm/store/v10/index.json", type: "file" })).toBe(true);
  });

  it("keeps what it saved when a save runs out of time, and the next save carries on from there", async () => {
    const source = folder();
    writeFileSync(join(source, "a-chats.db.json"), "the chats");
    writeFileSync(join(source, "b-notes.md"), "notes, first version");
    const store = memoryStore();
    const before = await snapshot(source, store, null, { scratch: folder() });
    writeFileSync(join(source, "a-chats.db.json"), "the chats, with today's messages");
    writeFileSync(join(source, "b-notes.md"), "notes, second version");
    writeFileSync(join(source, "c-new.txt"), "a new file");
    let clock = 0;
    const slow = await snapshot(source, store, before.manifest, { scratch: folder(), now: () => (clock += 10), budgetMs: 15 });
    expect(slow.written).toBe(true);
    expect(slow.uploaded).toBe(1);
    expect(slow.deferred).toBe(2);
    const files = (manifest: { entries: Array<{ path: string; type: string; chunks?: string[] }> }) =>
      Object.fromEntries(manifest.entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.chunks]));
    expect(files(slow.manifest)["a-chats.db.json"]).not.toEqual(files(before.manifest)["a-chats.db.json"]);
    expect(files(slow.manifest)["b-notes.md"]).toEqual(files(before.manifest)["b-notes.md"]);
    expect(files(slow.manifest)["c-new.txt"]).toBeUndefined();
    const next = await snapshot(source, store, slow.manifest, { scratch: folder() });
    expect(next.deferred).toBe(0);
    expect(next.uploaded).toBe(2);
    expect(Object.keys(files(next.manifest)).sort()).toEqual(["a-chats.db.json", "b-notes.md", "c-new.txt"]);
  });

  it("reaches a new file that sorts after one that changes on every save, where starting from the top each time never does", async () => {
    const source = folder();
    mkdirSync(join(source, "workspaces", "dog"), { recursive: true });
    writeFileSync(join(source, "messages.json"), "chats 0");
    const store = memoryStore();
    const first = await snapshot(source, store, null, { scratch: folder() });
    writeFileSync(join(source, "workspaces", "dog", "notes.md"), "today's notes");
    const oneFilePerSave = () => {
      let clock = 0;
      return { now: () => (clock += 10), budgetMs: 15, parallel: 1 };
    };
    const saved = (manifest: { entries: Array<{ path: string }> }) => manifest.entries.map((entry) => entry.path);

    let fromTheTop = first.manifest;
    for (let round = 1; round <= 5; round += 1) {
      writeFileSync(join(source, "messages.json"), `chats ${round}, from the top`);
      fromTheTop = (await snapshot(source, store, fromTheTop, { scratch: folder(), ...oneFilePerSave() })).manifest;
    }
    expect(saved(fromTheTop)).toContain("workspaces/dog");
    expect(saved(fromTheTop)).not.toContain("workspaces/dog/notes.md");

    let manifest = first.manifest;
    let resumeAfter: string | undefined;
    const reached: number[] = [];
    for (let round = 1; round <= 4; round += 1) {
      writeFileSync(join(source, "messages.json"), `chats ${round}, taking turns`);
      const result = await snapshot(source, store, manifest, { scratch: folder(), ...oneFilePerSave(), resumeAfter });
      manifest = result.manifest;
      resumeAfter = result.resumeAfter;
      if (saved(manifest).includes("workspaces/dog/notes.md")) reached.push(round);
    }
    expect(reached[0]).toBe(2);
    const woken = folder();
    await restore(woken, store, null);
    expect(readFileSync(join(woken, "workspaces", "dog", "notes.md"), "utf8")).toBe("today's notes");
    expect(readFileSync(join(woken, "messages.json"), "utf8")).toMatch(/^chats [34], taking turns$/);
  });

  it("always saves at least one waiting file, even when listing the home used up the whole budget", async () => {
    const source = folder();
    writeFileSync(join(source, "a.md"), "one");
    writeFileSync(join(source, "b.md"), "two");
    const store = memoryStore();
    let clock = 0;
    const late = await snapshot(source, store, null, { scratch: folder(), now: () => (clock += 1_000), budgetMs: 1, parallel: 1 });
    expect(late.uploaded).toBe(1);
    expect(late.deferred).toBe(1);
    expect(late.resumeAfter).toBe("a.md");
    const next = await snapshot(source, store, late.manifest, { scratch: folder(), now: () => (clock += 1_000), budgetMs: 1, parallel: 1, resumeAfter: late.resumeAfter });
    expect(next.manifest.entries.map((entry: { path: string }) => entry.path).sort()).toEqual(["a.md", "b.md"]);
    expect(next.resumeAfter).toBeUndefined();
  });

  it("carries on in the order the home is listed, folder by folder, and wraps round to the top", () => {
    const listed = ["a", "a/b.md", "a/c/d.md", "a-b.md", "b.md"];
    expect([...listed].sort(walkOrder)).toEqual(listed);
    const waiting = listed.map((path) => ({ entry: { path } }));
    const paths = (items: Array<{ entry: { path: string } }>) => items.map((item) => item.entry.path);
    expect(paths(resumeOrder(waiting, undefined))).toEqual(listed);
    expect(paths(resumeOrder(waiting, "a/b.md"))).toEqual(["a/c/d.md", "a-b.md", "b.md", "a", "a/b.md"]);
    expect(paths(resumeOrder(waiting, "a/gone-since.md"))).toEqual(["a-b.md", "b.md", "a", "a/b.md", "a/c/d.md"]);
    expect(paths(resumeOrder(waiting, "b.md"))).toEqual(listed);
    expect(paths(resumeOrder(waiting, "zz.md"))).toEqual(listed);
  });

  it("uploads several files at once, never more than its limit, and still records every one", async () => {
    const source = folder();
    for (let index = 0; index < 40; index += 1) writeFileSync(join(source, `note-${String(index).padStart(2, "0")}.md`), `note ${index}`);
    const store = memoryStore();
    let inFlight = 0;
    let most = 0;
    const put = store.put.bind(store);
    store.put = async (hash: string, bytes: Uint8Array) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return put(hash, bytes);
    };
    const result = await snapshot(source, store, null, { scratch: folder() });
    expect(result.uploaded).toBe(40);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(SAVE_PARALLEL);
    const woken = folder();
    await restore(woken, store, null);
    expect(readdirSync(woken).length).toBe(40);
    expect(readFileSync(join(woken, "note-39.md"), "utf8")).toBe("note 39");
  });

  it("copies one database at a time, so two never need scratch room together", async () => {
    const source = folder();
    for (const name of ["a.db", "b.db", "c.db"]) {
      const db = new DatabaseSync(join(source, name));
      db.exec("create table notes (body text); insert into notes values ('kept')");
      db.close();
    }
    const scratch = folder();
    const copiesSeen: number[] = [];
    const result = await snapshot(source, memoryStore(), null, {
      scratch,
      freeBytes: () => {
        copiesSeen.push(readdirSync(scratch).filter((name) => name.endsWith(".sqlite")).length);
        return Number.MAX_SAFE_INTEGER;
      },
    });
    expect(result.uploaded).toBe(3);
    expect(copiesSeen).toEqual([0, 0, 0]);
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

describe("saving a database only when its copy has room", () => {
  function liveDatabase(source: string): DatabaseSync {
    const database = new DatabaseSync(join(source, "messages.db"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('first');");
    return database;
  }

  function notes(root: string): string[] {
    const copy = new DatabaseSync(join(root, "messages.db"));
    try {
      return copy.prepare("SELECT body FROM notes ORDER BY rowid").all().map((row) => (row as { body: string }).body);
    } finally {
      copy.close();
    }
  }

  function entryFor(manifest: { entries: Entry[] }, path: string): Entry | undefined {
    return manifest.entries.find((candidate) => candidate.path === path);
  }

  function needed(source: string): number {
    return statSync(join(source, "messages.db")).size + statSync(join(source, "messages.db-wal")).size + SNAPSHOT_RESERVE_BYTES;
  }

  it("keeps the last saved database, still saves other files, and copies nothing when scratch lacks room for the database, its log and the reserve", async () => {
    const source = folder();
    const scratch = folder();
    writeFileSync(join(source, "chats.json"), "old chats");
    const database = liveDatabase(source);
    const store = memoryStore();
    const first = await snapshot(source, store, null, { scratch });
    const saved = entryFor(first.manifest, "messages.db");
    expect(saved?.chunks.length).toBeGreaterThan(0);
    database.exec("INSERT INTO notes VALUES ('second')");
    writeFileSync(join(source, "chats.json"), "new chats");
    const blobs = store.blobs.size;
    const seen: string[][] = [];
    const tight = await snapshot(source, store, first.manifest, {
      scratch,
      freeBytes: async (path: string) => {
        seen.push(readdirSync(path));
        return needed(source) - 1;
      },
    });
    expect(seen).toEqual([[]]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(tight.unsaved).toEqual(["messages.db"]);
    expect(entryFor(tight.manifest, "messages.db")).toEqual(saved);
    expect(store.blobs.size).toBe(blobs + 1);
    const target = folder();
    await restore(target, store, null);
    expect(readFileSync(join(target, "chats.json"), "utf8")).toBe("new chats");
    expect(notes(target)).toEqual(["first"]);

    const roomy = await snapshot(source, store, tight.manifest, { scratch, freeBytes: async () => needed(source) });
    expect(roomy.unsaved).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    const later = folder();
    await restore(later, store, null);
    expect(notes(later)).toEqual(["first", "second"]);
    database.close();
  });

  it("does not copy when free space cannot be read or is not a number, and keeps the last saved entry", async () => {
    const source = folder();
    const scratch = folder();
    const database = liveDatabase(source);
    const store = memoryStore();
    const first = await snapshot(source, store, null, { scratch });
    const saved = entryFor(first.manifest, "messages.db");
    database.exec("INSERT INTO notes VALUES ('second')");
    const unreadable = await snapshot(source, store, first.manifest, { scratch, freeBytes: async () => { throw Object.assign(new Error("statfs failed"), { code: "ENOENT" }); } });
    const unknown = await snapshot(source, store, unreadable.manifest, { scratch, freeBytes: async () => Number.NaN });
    database.close();
    for (const result of [unreadable, unknown]) {
      expect(result.unsaved).toEqual(["messages.db"]);
      expect(entryFor(result.manifest, "messages.db")).toEqual(saved);
    }
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("never records a database it has not saved before when there is no room for its first copy", async () => {
    const source = folder();
    const scratch = folder();
    writeFileSync(join(source, "chats.json"), "the chats");
    const database = liveDatabase(source);
    const store = memoryStore();
    const tight = await snapshot(source, store, null, { scratch, freeBytes: async () => 0 });
    database.close();
    expect(tight.unsaved).toEqual(["messages.db"]);
    expect(tight.manifest.entries.map((entry: Entry) => entry.path)).toEqual(["chats.json"]);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("saves the newest rows, including those still only in the log, once a later save has room again, measuring the real disk by default", async () => {
    const source = folder();
    const scratch = folder();
    const database = liveDatabase(source);
    const store = memoryStore();
    const tight = await snapshot(source, store, null, { scratch, freeBytes: async () => 0 });
    database.exec("INSERT INTO notes VALUES ('only in the log')");
    expect(statSync(join(source, "messages.db-wal")).size).toBeGreaterThan(0);
    const next = await snapshot(source, store, tight.manifest, { scratch });
    database.close();
    expect(next.unsaved).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    const target = folder();
    await restore(target, store, null);
    expect(notes(target)).toEqual(["first", "only in the log"]);
  });

  it("removes the copy at once when its upload fails, keeps the last saved entry, and saves it on the next try", async () => {
    const source = folder();
    const scratch = folder();
    const database = liveDatabase(source);
    const store = memoryStore();
    const first = await snapshot(source, store, null, { scratch });
    const saved = entryFor(first.manifest, "messages.db");
    database.exec("INSERT INTO notes VALUES ('second')");
    const put = store.put.bind(store);
    let refuse = true;
    store.put = async (hash: string, bytes: Uint8Array) => {
      if (refuse) throw new Error("store unavailable");
      return put(hash, bytes);
    };
    const failed = await snapshot(source, store, first.manifest, { scratch });
    expect(failed.unsaved).toEqual(["messages.db"]);
    expect(entryFor(failed.manifest, "messages.db")).toEqual(saved);
    expect(readdirSync(scratch)).toEqual([]);
    refuse = false;
    const next = await snapshot(source, store, failed.manifest, { scratch });
    database.close();
    expect(next.unsaved).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    const target = folder();
    await restore(target, store, null);
    expect(notes(target)).toEqual(["first", "second"]);
  });

  it("removes a partial copy when SQLite's backup itself fails, and still saves the other files", async () => {
    const source = folder();
    const scratch = folder();
    writeFileSync(join(source, "chats.json"), "the chats");
    writeFileSync(join(source, "broken.db"), randomBytes(64 * 1024));
    const store = memoryStore();
    const saved = await snapshot(source, store, null, { scratch });
    expect(saved.unsaved).toEqual(["broken.db"]);
    expect(saved.manifest.entries.map((entry: Entry) => entry.path)).toEqual(["chats.json"]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(statSync(join(source, "broken.db")).size).toBe(64 * 1024);
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

  it("removes old pieces in short rounds, so a save never waits long behind a cleanup, and later rounds finish it", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "notes.md"), "kept");
    const saved = await snapshot(home, store, null);
    for (let index = 0; index < 20; index += 1) store.blobs.set(createHash("sha256").update(`old ${index}`).digest("hex"), new Uint8Array([index]));
    let clock = 0;
    const slow = { ...store, deleteBlob: async (hash: string) => { clock += 100; await store.deleteBlob(hash); } };
    const first = await collectGarbageWithin(slow, saved.manifest, { budgetMs: 1_000, now: () => clock });
    expect(first).toEqual({ removed: 16, finished: false });
    const second = await collectGarbageWithin(slow, saved.manifest, { budgetMs: 1_000, now: () => clock });
    expect(second).toEqual({ removed: 4, finished: true });
    expect(new Set(store.blobs.keys())).toEqual(referencedBlobs(saved.manifest));
  });

  it("deletes eight pieces at a time, and still removes one round when the time is already up", async () => {
    const home = folder();
    const store = memoryStore();
    writeFileSync(join(home, "notes.md"), "kept");
    const saved = await snapshot(home, store, null);
    for (let index = 0; index < 30; index += 1) store.blobs.set(createHash("sha256").update(`stale ${index}`).digest("hex"), new Uint8Array([index]));
    let inFlight = 0;
    let most = 0;
    const counting = { ...store, deleteBlob: async (hash: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await store.deleteBlob(hash);
      inFlight -= 1;
    } };
    expect(await collectGarbageWithin(counting, saved.manifest, { budgetMs: 0 })).toEqual({ removed: CLEANUP_PARALLEL, finished: false });
    expect(most).toBe(CLEANUP_PARALLEL);
    expect(await collectGarbageWithin(counting, saved.manifest)).toEqual({ removed: 30 - CLEANUP_PARALLEL, finished: true });
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
