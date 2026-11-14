import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { open } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createExclusive, createFolderAway, MARKER, parseMarker, RELEASED_FILE } from "../runtime/folder-away.mjs";
import { restore, snapshot } from "../runtime/sync.mjs";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    const loosen = (at: string) => {
      try { chmodSync(at, 0o700); } catch {}
      let names: string[] = [];
      try { names = lstatSync(at).isDirectory() && !lstatSync(at).isSymbolicLink() ? readdirSync(at) : []; } catch {}
      for (const name of names) loosen(join(at, name));
    };
    loosen(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "folder-away-")); made.push(dir); return dir; };
const OLD = new Date(Date.UTC(2026, 8, 1));
const BOT = "dog-1";
const CHAT = "thread-a";

function put(path: string, text: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, OLD, OLD);
}

type Fault = "put" | "get" | "has" | "corrupt" | null;

function memory() {
  const archived = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  let manifest: unknown = null;
  const state = { fault: null as Fault, gets: 0, failGetsAfter: Infinity };
  return {
    archived, blobs, state,
    async hasArchived(hash: string) { if (state.fault === "has") throw new Error("storage unreachable"); return archived.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { if (state.fault === "put") throw new Error("storage refused"); archived.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) {
      if (state.fault === "get" || ++state.gets > state.failGetsAfter) throw new Error("storage unreachable");
      const bytes = archived.get(hash);
      if (!bytes) throw new Error("missing");
      if (state.fault === "corrupt") { const copy = new Uint8Array(bytes); copy[0] ^= 1; return copy; }
      return bytes;
    },
    async manifest() { return structuredClone(manifest); },
    async putManifest(next: unknown) { manifest = structuredClone(next); },
    async has(hash: string) { return blobs.has(hash); },
    async put(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async get(hash: string) { const bytes = blobs.get(hash); if (!bytes) throw new Error("missing blob"); return bytes; },
  };
}

function chatTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      const info = lstatSync(full);
      const path = relative(root, full);
      if (info.isSymbolicLink()) out[path] = "link";
      else if (info.isDirectory()) { out[path] = `dir:${(info.mode & 0o777).toString(8)}`; walk(full); }
      else out[path] = `file:${(info.mode & 0o777).toString(8)}:${Math.trunc(info.mtimeMs)}:${readFileSync(full).toString("base64")}`;
    }
  };
  walk(root);
  return out;
}

function fixture(options: { pieceBytes?: number; free?: number; recordMaxBytes?: number } = {}) {
  const root = scratch();
  const tasksDir = join(root, ".laterdog", "task-workspaces");
  const ledgerDir = join(root, ".laterdog", "folders-away");
  const dir = join(tasksDir, BOT, CHAT);
  put(join(dir, "notes.md"), "# plan\nship it\n");
  put(join(dir, "src", "app.ts"), Buffer.alloc(70_000, 7));
  put(join(dir, "src", "empty.txt"), "");
  put(join(dir, ".git", "objects", "pack"), Buffer.alloc(30_000, 9));
  put(join(dir, "node_modules", "left", "index.js"), "rebuildable");
  put(join(dir, "data.db-wal"), "wal");
  chmodSync(join(dir, "notes.md"), 0o640);
  utimesSync(join(dir, "notes.md"), OLD, OLD);
  symlinkSync("src/app.ts", join(dir, "shortcut"));
  mkdirSync(join(dir, "empty-folder"));
  const store = memory();
  const lines: string[] = [];
  const lock = createExclusive();
  const free = { bytes: options.free ?? 100 * 1024 ** 3 };
  const away = createFolderAway({
    tasksDir, ledgerDir, store, lock, log: (line: string) => lines.push(line), retryMs: 1,
    freeBytes: async () => free.bytes, pieceBytes: options.pieceBytes ?? 16 * 1024, ...(options.recordMaxBytes ? { recordMaxBytes: options.recordMaxBytes } : {}),
  });
  const kept = () => Object.fromEntries(Object.entries(chatTree(dir)).filter(([path]) => !path.startsWith("node_modules") && path !== "data.db-wal"));
  return { root, tasksDir, ledgerDir, dir, store, lines, lock, away, free, kept };
}

const leftovers = (tasksDir: string) => readdirSync(join(tasksDir, BOT)).filter((name) => name.startsWith(".laterdog-restoring-"));
const markerOnly = (dir: string) => readdirSync(dir).length === 1 && existsSync(join(dir, MARKER));

describe("packing a chat folder", () => {
  it("stores every file the save keeps, verified, and lists what it left out", async () => {
    const f = fixture();
    const before = f.kept();
    const packed = await f.away.pack(BOT, CHAT);
    expect(packed).toMatchObject({ files: 4, bytes: "# plan\nship it\n".length + 100_000, leftOut: { count: 2 } });
    expect(packed.pieces).toBeGreaterThan(1);
    const record = JSON.parse(Buffer.from(f.store.archived.get(packed.record)!).toString());
    expect(record.leftOut.paths).toEqual(["data.db-wal", "node_modules"]);
    expect(record.entries.map((entry: { path: string }) => entry.path)).toEqual([".git", ".git/objects", ".git/objects/pack", "empty-folder", "notes.md", "shortcut", "src", "src/app.ts", "src/empty.txt"]);
    expect(f.kept()).toEqual(before);
    expect(leftovers(f.tasksDir)).toEqual([]);
  });

  for (const fault of ["put", "get", "has", "corrupt"] as const) {
    it(`leaves the folder untouched and moves nothing when storage fails (${fault})`, async () => {
      const f = fixture();
      const before = chatTree(f.dir);
      f.store.state.fault = fault;
      await expect(f.away.move(BOT, CHAT)).rejects.toThrow();
      expect(chatTree(f.dir)).toEqual(before);
      expect(leftovers(f.tasksDir)).toEqual([]);
    });
  }

  it("refuses a folder with more files than one record can list, and a folder already away", async () => {
    const f = fixture({ recordMaxBytes: 200 });
    await expect(f.away.move(BOT, CHAT)).rejects.toThrow(/too many files/);
    expect(existsSync(join(f.dir, "notes.md"))).toBe(true);
    const g = fixture();
    await g.away.move(BOT, CHAT);
    await expect(g.away.pack(BOT, CHAT)).rejects.toThrow(/already away/);
    await expect(g.away.pack(BOT, "../x")).rejects.toThrow(/not a chat folder/);
  });
});

describe("moving it away", () => {
  it("leaves only a read-only marker that says what happened and how the files come back", async () => {
    const f = fixture();
    const moved = await f.away.move(BOT, CHAT);
    expect(moved).toMatchObject({ moved: true, files: 4 });
    expect(markerOnly(f.dir)).toBe(true);
    const marker = parseMarker(readFileSync(join(f.dir, MARKER), "utf8"));
    expect(marker).toMatchObject({ botId: BOT, threadId: CHAT, record: moved.record, files: 4, where: "this home's Cloud storage" });
    expect(marker.note).toMatch(/Nothing was deleted/);
    expect(marker.note).toMatch(/next time this chat gets a message or its files are opened in the app/);
    expect(lstatSync(join(f.dir, MARKER)).mode & 0o777).toBe(0o444);
    expect(lstatSync(f.dir).mode & 0o777).toBe(0o755);
    expect(leftovers(f.tasksDir)).toEqual([]);
    expect(f.lines.at(-1)).toMatch(/^moved chat thread-a's files \(4 files, 0 MB\) to Cloud storage$/);
  });

  it("keeps the folder when something changes between the copy and the swap, and says so", async () => {
    const f = fixture();
    const packed = await f.away.pack(BOT, CHAT);
    put(join(f.dir, "src", "written-by-a-teammate.txt"), "new work");
    expect(await f.away.swap(packed.id)).toEqual({ kept: "changed" });
    expect(readFileSync(join(f.dir, "src", "written-by-a-teammate.txt"), "utf8")).toBe("new work");
    expect(existsSync(join(f.dir, MARKER))).toBe(false);
    expect(leftovers(f.tasksDir)).toEqual([]);
    expect(f.lines.at(-1)).toMatch(/kept chat thread-a's files where they are/);
  });

  it("catches a write by an already-open file in the last moment before the rename, inside the save lock", async () => {
    const f = fixture();
    const handle = await open(join(f.dir, "notes.md"), "r+");
    const g = createFolderAway({
      tasksDir: f.tasksDir, ledgerDir: f.ledgerDir, store: f.store, freeBytes: async () => 1e12,
      lock: { run: async <T>(work: () => Promise<T>) => { await handle.write("late write from a teammate", 0); await handle.close(); return work(); } },
    });
    const packed = await g.pack(BOT, CHAT);
    expect(await g.swap(packed.id)).toEqual({ kept: "changed" });
    expect(readFileSync(join(f.dir, "notes.md"), "utf8")).toMatch(/^late write from a teammate/);
    expect(existsSync(join(f.dir, MARKER))).toBe(false);
    expect(leftovers(f.tasksDir)).toEqual([]);
  });
});

describe("bringing it back", () => {
  it("restores every kept file byte for byte, with modes, times, links and empty folders", async () => {
    const f = fixture();
    const before = f.kept();
    await f.away.move(BOT, CHAT);
    expect(await f.away.bringBack(BOT, CHAT)).toMatchObject({ back: true, files: 4 });
    expect(chatTree(f.dir)).toEqual(before);
    expect(leftovers(f.tasksDir)).toEqual([]);
    expect(await f.away.bringBack(BOT, CHAT)).toEqual({ here: true });
    expect(f.lines.at(-1)).toMatch(/^brought back chat thread-a's files \(4 files, 0 MB\) from Cloud storage$/);
  });

  for (const fault of ["get", "corrupt"] as const) {
    it(`leaves the marker and nothing half-built when storage fails (${fault})`, async () => {
      const f = fixture();
      await f.away.move(BOT, CHAT);
      const marker = readFileSync(join(f.dir, MARKER), "utf8");
      f.store.state.fault = fault;
      await expect(f.away.bringBack(BOT, CHAT)).rejects.toThrow();
      expect(markerOnly(f.dir)).toBe(true);
      expect(readFileSync(join(f.dir, MARKER), "utf8")).toBe(marker);
      expect(leftovers(f.tasksDir)).toEqual([]);
      expect(f.lines.at(-1)).toMatch(/could not bring back chat thread-a's files yet: .*marker stays and nothing was deleted/);
      f.store.state.fault = null;
      expect(await f.away.bringBack(BOT, CHAT)).toMatchObject({ back: true });
    });
  }

  it("fails part-way through the pieces without leaving anything where the folder belongs", async () => {
    const f = fixture();
    await f.away.move(BOT, CHAT);
    f.store.state.gets = 0;
    f.store.state.failGetsAfter = 3;
    await expect(f.away.bringBack(BOT, CHAT)).rejects.toThrow();
    expect(markerOnly(f.dir)).toBe(true);
    expect(leftovers(f.tasksDir)).toEqual([]);
  });

  it("checks free space first and answers with how much is missing", async () => {
    const f = fixture();
    const moved = await f.away.move(BOT, CHAT);
    f.free.bytes = 2 * 1024 ** 3;
    const answer = await f.away.bringBack(BOT, CHAT);
    expect(answer).toEqual({ short: { needBytes: moved.bytes, freeBytes: 2 * 1024 ** 3, bytes: moved.bytes } });
    expect(markerOnly(f.dir)).toBe(true);
  });

  it("never swaps over a folder that holds anything but the exact marker: the files come back beside it", async () => {
    const f = fixture();
    const before = f.kept();
    await f.away.move(BOT, CHAT);
    chmodSync(f.dir, 0o755);
    put(join(f.dir, "written-while-away.txt"), "by an older server");
    const beside = await f.away.bringBack(BOT, CHAT);
    expect(beside).toMatchObject({ back: true, beside: expect.stringMatching(/^thread-a-brought-back-[a-f0-9]{8}$/) });
    expect(chatTree(join(f.tasksDir, BOT, beside.beside))).toEqual(before);
    expect(readdirSync(f.dir)).toEqual(["written-while-away.txt"]);
    expect(f.lines.at(-1)).toMatch(/beside its folder as thread-a-brought-back-.*something new was written there/);
    expect(await f.away.bringBack(BOT, CHAT)).toEqual({ here: true });
    expect(leftovers(f.tasksDir)).toEqual([]);
  });

  it("checks the marker again under the save lock and swaps only when it is unchanged", async () => {
    const f = fixture();
    const before = f.kept();
    await f.away.move(BOT, CHAT);
    const g = createFolderAway({
      tasksDir: f.tasksDir, ledgerDir: f.ledgerDir, store: f.store, freeBytes: async () => 1e12,
      lock: { run: async <T>(work: () => Promise<T>) => { chmodSync(f.dir, 0o755); writeFileSync(join(f.dir, "late.txt"), "late"); return work(); } },
    });
    const answer = await g.bringBack(BOT, CHAT);
    expect(answer.beside).toBeTruthy();
    expect(chatTree(join(f.tasksDir, BOT, answer.beside))).toEqual(before);
    expect(readdirSync(f.dir)).toEqual(["late.txt"]);
  });
});

describe("a kill at any moment", () => {
  async function saveAndRestore(f: ReturnType<typeof fixture>, previous: unknown) {
    const result = await f.lock.run(() => snapshot(f.root, f.store, previous as never, {}));
    return result.manifest;
  }

  function woken(f: ReturnType<typeof fixture>) {
    const fresh = scratch();
    return restore(fresh, f.store, null).then(() => join(fresh, ".laterdog", "task-workspaces", BOT, CHAT));
  }

  it("never leaves a save that holds neither the folder nor its marker, across a move and a return", async () => {
    const f = fixture();
    const whole = f.kept();
    let manifest: unknown = null;
    let saving = true;
    const saves: unknown[] = [];
    const loop = (async () => {
      while (saving) {
        manifest = await saveAndRestore(f, manifest);
        saves.push(structuredClone(manifest));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await f.away.move(BOT, CHAT);
    await f.away.bringBack(BOT, CHAT);
    await f.away.move(BOT, CHAT);
    saving = false;
    await loop;
    expect(saves.length).toBeGreaterThan(2);
    const seen = new Set<string>();
    for (const saved of saves) {
      await f.store.putManifest(saved);
      const dir = await woken(f);
      expect(existsSync(dir), "the chat folder is in every save").toBe(true);
      if (markerOnly(dir)) { seen.add("marker"); continue; }
      seen.add("whole");
      const restored = Object.fromEntries(Object.entries(chatTree(dir)).filter(([path]) => !path.startsWith("node_modules") && path !== "data.db-wal"));
      expect(Object.keys(restored).sort()).toEqual(Object.keys(whole).sort());
      expect(readdirSync(dirname(dir)).filter((name) => name.startsWith(".laterdog-restoring-"))).toEqual([]);
    }
    expect(seen).toEqual(new Set(["whole", "marker"]));
  });

  it("after a woken home keeps only the marker, the files still come back whole from storage", async () => {
    const f = fixture();
    const whole = f.kept();
    await f.away.move(BOT, CHAT);
    await saveAndRestore(f, null);
    const fresh = scratch();
    await restore(fresh, f.store, null);
    const tasksDir = join(fresh, ".laterdog", "task-workspaces");
    const again = createFolderAway({ tasksDir, ledgerDir: join(fresh, ".laterdog", "folders-away"), store: f.store, freeBytes: async () => 1e12 });
    expect(markerOnly(join(tasksDir, BOT, CHAT))).toBe(true);
    await again.bringBack(BOT, CHAT);
    expect(chatTree(join(tasksDir, BOT, CHAT))).toEqual(whole);
  });

  it("a server that dies between the copy and the swap loses nothing: the folder stays and a new copy can be made", async () => {
    const f = fixture();
    const before = chatTree(f.dir);
    await f.away.pack(BOT, CHAT);
    const restarted = createFolderAway({ tasksDir: f.tasksDir, ledgerDir: f.ledgerDir, store: f.store, freeBytes: async () => 1e12 });
    expect(chatTree(f.dir)).toEqual(before);
    expect(await restarted.move(BOT, CHAT)).toMatchObject({ moved: true });
  });

  it("recovers every half-done state a runtime restart could find, keeping the files and the marker", async () => {
    const f = fixture();
    const whole = chatTree(f.dir);
    const kept = f.kept();
    const botDir = join(f.tasksDir, BOT);
    const id = "0123456789abcdef";
    renameSync(f.dir, join(botDir, `.laterdog-restoring-away.${id}.${CHAT}`));
    mkdirSync(join(botDir, `.laterdog-restoring-stub.${id}.${CHAT}`));
    expect(await f.away.recover()).toHaveLength(2);
    expect(chatTree(f.dir)).toEqual(whole);
    expect(leftovers(f.tasksDir)).toEqual([]);

    const moved = await f.away.move(BOT, CHAT);
    expect(moved.moved).toBe(true);
    mkdirSync(join(botDir, `.laterdog-restoring-away.${id}.${CHAT}`, "src"), { recursive: true });
    mkdirSync(join(botDir, `.laterdog-restoring-back.${id}.${CHAT}`, "half"), { recursive: true });
    await f.away.recover();
    expect(markerOnly(f.dir)).toBe(true);
    expect(leftovers(f.tasksDir)).toEqual([]);

    chmodSync(f.dir, 0o755);
    renameSync(f.dir, join(botDir, `.laterdog-restoring-gone.${id}.${CHAT}`));
    await f.away.recover();
    expect(markerOnly(f.dir)).toBe(true);

    await f.away.bringBack(BOT, CHAT);
    mkdirSync(join(botDir, `.laterdog-restoring-gone.${id}.${CHAT}`));
    mkdirSync(join(botDir, `.laterdog-restoring-away.${"f".repeat(16)}.${CHAT}`, "x"), { recursive: true });
    await f.away.recover();
    expect(f.kept()).toEqual(kept);
    expect(readdirSync(botDir).sort()).toEqual([CHAT, `${CHAT}-kept-ffffffff`]);
  });
});

describe("releasing and reporting", () => {
  it("records once that a removed chat's stored files are no longer needed, and deletes nothing", async () => {
    const f = fixture();
    const moved = await f.away.move(BOT, CHAT);
    const pieces = f.store.archived.size;
    expect(await f.away.status()).toMatchObject({ away: 1, bytes: moved.bytes, released: 0 });
    expect(await f.away.release(BOT, CHAT)).toEqual({ released: true });
    expect(await f.away.release(BOT, CHAT)).toEqual({ released: true, already: true });
    const rows = readFileSync(join(f.ledgerDir, RELEASED_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toEqual([expect.objectContaining({ botId: BOT, threadId: CHAT, record: moved.record, bytes: moved.bytes, releasedAt: expect.any(String) })]);
    expect(f.store.archived.size).toBe(pieces);
    expect(markerOnly(f.dir)).toBe(true);
    expect(await f.away.status()).toMatchObject({ away: 0, bytes: 0, released: 1 });
    expect(await f.away.release(BOT, "thread-none")).toEqual({ released: false });
  });
});
