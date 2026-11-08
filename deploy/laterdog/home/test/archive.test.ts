import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archivable, createArchiver, parseIndex, serveArchive } from "../runtime/archive.mjs";

const made: string[] = [];
const folder = () => { const root = mkdtempSync(join(tmpdir(), "laterdog-archive-")); made.push(root); return root; };
afterEach(() => { for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true }); });
const PATH = ".laterdog/events/thread-123456.ndjson";
const put = (root: string, path = PATH, text = "original transcript") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  return {
    blobs,
    async archiveIndex() { return structuredClone(index); },
    async putArchiveIndex(next: unknown) { index = structuredClone(next); },
    async hasArchived(hash: string) { return blobs.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) { const bytes = blobs.get(hash); if (!bytes) throw new Error("missing"); return bytes; },
    async listArchived() { return { hashes: [...blobs.keys()] }; },
    async deleteArchived(hash: string) { blobs.delete(hash); },
  };
}

describe("verified cold archive", () => {
  it("round-trips the exact bytes after an archiver restart and preserves the remote copy", async () => {
    const root = folder();
    const store = memory();
    put(root);
    const archive = createArchiver({ root, store });
    expect(await archive.archive([PATH])).toMatchObject({ archived: 1, bytes: 19 });
    expect(existsSync(join(root, PATH))).toBe(false);
    const resumed = createArchiver({ root, store });
    expect(await resumed.restore(["thread-123456"])).toMatchObject({ restored: 1, failed: 0 });
    expect(readFileSync(join(root, PATH), "utf8")).toBe("original transcript");
    rmSync(join(root, PATH));
    expect(await createArchiver({ root, store }).restore(["thread-123456"])).toMatchObject({ restored: 1 });
    expect(store.blobs.size).toBe(1);
  });

  it("keeps the local file when uploading or reading back the remote bytes fails", async () => {
    for (const failure of ["upload", "readback"]) {
      const root = folder();
      const store = memory();
      put(root);
      if (failure === "upload") store.putArchived = async () => { throw new Error("offline"); };
      else store.getArchived = async () => new Uint8Array([1, 2, 3]);
      expect(await createArchiver({ root, store }).archive([PATH])).toMatchObject({ archived: 0 });
      expect(readFileSync(join(root, PATH), "utf8")).toBe("original transcript");
    }
  });

  it("keeps the local file until the saved index is read back and verified", async () => {
    const root = folder();
    const store = memory();
    put(root);
    store.putArchiveIndex = async () => undefined;
    expect(await createArchiver({ root, store }).archive([PATH])).toMatchObject({ archived: 0 });
    expect(existsSync(join(root, PATH))).toBe(true);
  });

  it("refuses changed files while the upload is in flight", async () => {
    const root = folder();
    const store = memory();
    put(root);
    const upload = store.putArchived;
    store.putArchived = async (hash, bytes) => { await upload(hash, bytes); writeFileSync(join(root, PATH), "new transcript with more words"); };
    expect(await createArchiver({ root, store }).archive([PATH])).toMatchObject({ archived: 0 });
    expect(readFileSync(join(root, PATH), "utf8")).toContain("new transcript");
  });

  it("keeps an existing local file rather than replacing it with an older archived one", async () => {
    const root = folder();
    const store = memory();
    put(root);
    const archive = createArchiver({ root, store });
    await archive.archive([PATH]);
    put(root, PATH, "newer transcript");
    await archive.restore(["thread-123456"]);
    expect(readFileSync(join(root, PATH), "utf8")).toBe("newer transcript");
    expect(store.blobs.size).toBe(1);
  });

  it("does not publish corrupt restored bytes at the final path", async () => {
    const root = folder();
    const store = memory();
    put(root);
    const archive = createArchiver({ root, store });
    await archive.archive([PATH]);
    store.getArchived = async () => new Uint8Array([7]);
    expect(await archive.restore(["thread-123456"])).toMatchObject({ restored: 0, failed: 1 });
    expect(existsSync(join(root, PATH))).toBe(false);
  });

  it("refuses symlink ancestors for both archive and restoration", async () => {
    const root = folder();
    const outside = folder();
    mkdirSync(join(root, ".laterdog"), { recursive: true });
    writeFileSync(join(outside, "thread-123456.ndjson"), "outside");
    symlinkSync(outside, join(root, ".laterdog/events"));
    expect(await createArchiver({ root, store: memory() }).archive([PATH])).toMatchObject({ archived: 0 });
    expect(readFileSync(join(outside, "thread-123456.ndjson"), "utf8")).toBe("outside");
    const safe = folder();
    const store = memory();
    put(safe);
    await createArchiver({ root: safe, store }).archive([PATH]);
    rmSync(join(outside, "thread-123456.ndjson"));
    expect(await createArchiver({ root, store }).restore(["thread-123456"])).toMatchObject({ restored: 0, failed: 1 });
    expect(existsSync(join(outside, "thread-123456.ndjson"))).toBe(false);
  });

  it("rejects unsafe paths, credential directories and malformed saved entries", () => {
    for (const path of ["../escape", "/absolute", ".laterdog/events/../auth.json", ".laterdog/providers/codex/auth.json", ".claude/projects/auth.json"]) expect(archivable(path)).toBe(false);
    expect(archivable(PATH)).toBe(true);
    expect(() => parseIndex({ version: 1, entries: { [PATH]: { chunks: [], size: -1, mtimeMs: 0 } } })).toThrow();
  });
});

it("keeps earlier archived versions reachable when a path is reused", async () => {
  const root = folder();
  const store = memory();
  put(root);
  const archive = createArchiver({ root, store });
  await archive.archive([PATH]);
  put(root, PATH, "new version");
  await archive.archive([PATH]);
  const index = await store.archiveIndex() as { entries: Record<string, { history: { size: number }[] }> };
  expect(index.entries[PATH].history).toHaveLength(1);
  expect(index.entries[PATH].history[0].size).toBe(19);
  expect(store.blobs.size).toBe(2);
});

it("archives and restores a file larger than a chunk without buffering the full file", async () => {
  const root = folder();
  const store = memory();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 13, 17);
  mkdirSync(dirname(join(root, PATH)), { recursive: true });
  writeFileSync(join(root, PATH), bytes);
  const archive = createArchiver({ root, store });
  expect(await archive.archive([PATH])).toMatchObject({ archived: 1, bytes: bytes.length });
  expect(store.blobs.size).toBe(2);
  await archive.restore(["thread-123456"]);
  expect(readFileSync(join(root, PATH)).equals(bytes)).toBe(true);
});

it("requires authorization and bounded requests on its loopback bridge", async () => {
  const root = folder();
  const store = memory();
  put(root);
  const bridge = await serveArchive(createArchiver({ root, store }), { token: "archive-fixture" });
  try {
    expect((await fetch(bridge.url + "/status")).status).toBe(401);
    const headers = { authorization: "Bearer archive-fixture", "content-type": "application/json" };
    expect((await fetch(bridge.url + "/archive", { method: "POST", headers, body: JSON.stringify({ paths: Array(2001).fill(PATH) }) })).status).toBe(400);
    expect(await (await fetch(bridge.url + "/archive", { method: "POST", headers, body: JSON.stringify({ paths: [PATH] }) })).json()).toMatchObject({ archived: 1 });
    expect(await (await fetch(bridge.url + "/restore", { method: "POST", headers, body: JSON.stringify({ contains: ["thread-123456"] }) })).json()).toMatchObject({ restored: 1 });
    expect(readFileSync(join(root, PATH), "utf8")).toBe("original transcript");
  } finally { await bridge.close(); }
});
