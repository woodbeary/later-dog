import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES, collectGarbage, parseManifest, referencedBlobs, restore, skipped, snapshot } from "../runtime/sync.mjs";

function memoryStore() {
  const blobs = new Map<string, Uint8Array>();
  let manifest: unknown = null;
  const counts = { puts: 0, manifests: 0 };
  return {
    blobs,
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

describe("home data sync", () => {
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
    expect(skipped("notes.md")).toBe(false);
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
