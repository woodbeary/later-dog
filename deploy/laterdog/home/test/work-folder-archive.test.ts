import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createArchiver, serveArchive } from "../runtime/archive.mjs";
import {
  CALM_WORK_FOLDERS,
  PRESSURE_WORK_FOLDERS,
  roomFor,
  workFolderSweep,
} from "../../../../server/laterdog/archive-pressure.ts";
import { DISK_RUNGS } from "../../../../server/laterdog/disk-ladder.ts";
import type { WorkspaceTask } from "../../../../server/laterdog/janitor.ts";
import { logArchiveBridge } from "../../../../server/laterdog/log-archive.ts";
import type { ProcessInfo } from "../../../../server/laterdog/process-reaper.ts";
import {
  MOVED_OUT_NOTE,
  WORK_FOLDER_PARTS,
  WORK_FOLDER_RECORDS,
  WorkFolderArchive,
  measureFolder,
  movedOutNote,
  type WorkFolderBridge,
  type WorkFolderDeps,
  type WorkFolderLimits,
} from "../../../../server/laterdog/work-folder-archive.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BOT = "11111111-2222-4333-8444-555555555555";
const THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const THIRD = "cccccccc-dddd-4eee-8fff-000000000000";
const ANY: WorkFolderLimits = { idleMs: DAY, byteLimit: Infinity, minBytes: 0, minFiles: 0 };

function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  return {
    async archiveIndex() {
      return structuredClone(index);
    },
    async putArchiveIndex(next: unknown) {
      index = structuredClone(next);
    },
    async hasArchived(hash: string) {
      return blobs.has(hash);
    },
    async putArchived(hash: string, bytes: Uint8Array) {
      blobs.set(hash, new Uint8Array(bytes));
    },
    async getArchived(hash: string) {
      const found = blobs.get(hash);
      if (!found) throw new Error("missing");
      return found;
    },
  };
}

function put(path: string, bytes: Buffer | string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  chmodSync(path, mode);
}

function tree(dir: string): string[] {
  const rows: string[] = [];
  const walk = (path: string, name: string) => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      const rel = name ? `${name}/${entry}` : entry;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) rows.push(`${rel} -> ${readlinkSync(full)}`);
      else if (info.isDirectory()) {
        rows.push(`${rel}/`);
        walk(full, rel);
      } else
        rows.push(
          `${rel} ${(info.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16)}`,
        );
    }
  };
  walk(dir, "");
  return rows;
}

async function fixture(storage = memory()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-folder-archive-")));
  roots.push(root);
  const dataDir = join(root, ".laterdog");
  const workspacesDir = join(dataDir, "task-workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  const service = await serveArchive(createArchiver({ root, store: storage }), {
    token: "work-folder-fixture",
  });
  cleanups.push(service.close);
  const bridge = logArchiveBridge(service.url, "work-folder-fixture") as WorkFolderBridge;
  const chats = new Map<string, WorkspaceTask>();
  const live: ProcessInfo[] = [];
  const logs: string[] = [];
  let limits = ANY;
  const dirOf = (thread: string, bot = BOT) => join(workspacesDir, bot, thread);
  const chat = (thread: string, over: Partial<WorkspaceTask> = {}) => {
    const dir = dirOf(thread);
    mkdirSync(dir, { recursive: true });
    chats.set(thread, {
      dir,
      busy: false,
      closed: false,
      lastActiveAt: Date.now() - 2 * DAY,
      ...over,
    });
    return dir;
  };
  const archive = (extra: Partial<WorkFolderDeps> = {}) =>
    new WorkFolderArchive({
      home: root,
      dataDir,
      workspacesDir,
      bridge,
      chats: () => [...chats.values()],
      live: () => live,
      limits: () => limits,
      room: () => true,
      log: (line) => logs.push(line),
      retryMs: 5,
      partBytes: 4096,
      ...extra,
    });
  return {
    root,
    dataDir,
    workspacesDir,
    bridge,
    storage,
    chats,
    live,
    logs,
    chat,
    dirOf,
    archive,
    limit(next: WorkFolderLimits) {
      limits = next;
    },
  };
}

function project(dir: string) {
  put(join(dir, "README.md"), "# a small project\n");
  put(join(dir, "src/index.ts"), "export const answer = 42;\n");
  put(join(dir, "src/auth.ts"), "export const token = 'not a real one';\n");
  put(join(dir, "bin/run.sh"), "#!/bin/sh\necho run\n", 0o755);
  put(join(dir, "assets/photo.bin"), Buffer.alloc(11_000, 7));
  put(
    join(dir, "assets/big.bin"),
    createHash("sha256").update("seed").digest().subarray(0, 32).toString("hex").repeat(400),
  );
  mkdirSync(join(dir, "empty/inside"), { recursive: true });
  symlinkSync("src/index.ts", join(dir, "latest"));
  mkdirSync(join(dir, ".git/objects/ab"), { recursive: true });
  put(join(dir, ".git/objects/ab/cdef"), Buffer.alloc(3000, 3), 0o444);
  put(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
}

it("moves a quiet chat's folder into storage in parts, leaves a note in its place, and keeps no part on the disk", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const before = await measureFolder(dir);
  const archive = f.archive();
  expect(await archive.sweep()).toBe(before.bytes);
  expect(readdirSync(dir)).toEqual([MOVED_OUT_NOTE]);
  expect(readFileSync(join(dir, MOVED_OUT_NOTE), "utf8")).toContain("Nothing was deleted");
  const record = archive.movedOut(BOT, THREAD)!;
  expect(record).toMatchObject({ bytes: before.bytes, files: before.files, cleared: true });
  expect(record.parts.length).toBeGreaterThan(3);
  expect(
    record.parts.every((part) => part.name.startsWith(`wf-${THREAD}-`) && part.bytes > 0),
  ).toBe(true);
  expect(
    existsSync(join(f.root, WORK_FOLDER_PARTS, BOT))
      ? readdirSync(join(f.root, WORK_FOLDER_PARTS, BOT))
      : [],
  ).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"))).toHaveProperty(
    `${BOT}/${THREAD}`,
  );
  expect(archive.status()).toMatchObject({ out: 1, outBytes: before.bytes, movedOut: 1 });
  expect(f.logs.at(-1)).toMatch(
    /^laterdog home: moved 1 quiet chat\(s\)' work folders into storage, freed \d+ MB$/,
  );
});

it("brings every file, folder, link and permission back exactly before the chat's next turn", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive();
  await archive.sweep();
  expect(tree(dir)).not.toEqual(original);
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
  expect(JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"))).toEqual({});
  expect(existsSync(join(f.root, WORK_FOLDER_PARTS, BOT))).toBe(false);
  expect(archive.status()).toMatchObject({ out: 0, broughtBack: 1 });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
});

it("a home that restarts between the two still brings the folder back from its saved record", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  const afterRestart = f.archive();
  expect(afterRestart.movedOut(BOT, THREAD)).not.toBeNull();
  expect(await afterRestart.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
});

it("keeps what the chat wrote while its folder was in storage", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const old = new Date(Date.now() - 5 * DAY);
  utimesSync(join(dir, "README.md"), old, old);
  const archive = f.archive();
  await archive.sweep();
  put(join(dir, "notes-from-today.md"), "written while the rest was away\n");
  put(join(dir, "README.md"), "# rewritten today\n");
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(readFileSync(join(dir, "notes-from-today.md"), "utf8")).toBe(
    "written while the rest was away\n",
  );
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# rewritten today\n");
  expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toBe("export const answer = 42;\n");
  expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(false);
});

it("leaves alone a busy chat, a recently active chat, a chat with a program running in its folder, an unknown folder and a folder too small to matter", async () => {
  const f = await fixture();
  const busy = f.chat(THREAD, { busy: true });
  const recent = f.chat(OTHER, { lastActiveAt: Date.now() - HOUR });
  const running = f.chat(THIRD);
  const unknown = f.chat("dddddddd-eeee-4fff-8000-111111111111", {
    lastActiveAt: null,
    closed: true,
  });
  const tiny = f.chat("eeeeeeee-ffff-4000-8111-222222222222");
  for (const dir of [busy, recent, running, unknown]) project(dir);
  put(join(tiny, "note.txt"), "small\n");
  f.live.push({ pid: 4242, ppid: 1, cwd: join(running, "src"), argv: "node server.js" });
  f.limit({ ...ANY, minBytes: 5 * MB, minFiles: 200 });
  const archive = f.archive();
  expect(await archive.sweep()).toBe(0);
  f.limit(ANY);
  expect(await archive.sweep()).toBeGreaterThan(0);
  for (const dir of [busy, recent, running, unknown])
    expect(existsSync(join(dir, MOVED_OUT_NOTE)), dir).toBe(false);
  expect(readdirSync(tiny)).toEqual([MOVED_OUT_NOTE]);
});

it("moves the quietest chats first, stops at the sweep's byte limit, and takes a folder larger than the limit alone", async () => {
  const f = await fixture();
  const newest = f.chat(THREAD, { lastActiveAt: Date.now() - 2 * DAY });
  const oldest = f.chat(OTHER, { lastActiveAt: Date.now() - 9 * DAY });
  const middle = f.chat(THIRD, { lastActiveAt: Date.now() - 5 * DAY });
  put(join(newest, "a.bin"), Buffer.alloc(6000, 1));
  put(join(oldest, "a.bin"), Buffer.alloc(6000, 2));
  put(join(middle, "a.bin"), Buffer.alloc(6000, 3));
  f.limit({ ...ANY, byteLimit: 7000 });
  const archive = f.archive();
  expect(await archive.sweep()).toBe(6000);
  expect([oldest, middle, newest].map((dir) => existsSync(join(dir, MOVED_OUT_NOTE)))).toEqual([
    true,
    false,
    false,
  ]);
  expect(await archive.sweep()).toBe(6000);
  expect([oldest, middle, newest].map((dir) => existsSync(join(dir, MOVED_OUT_NOTE)))).toEqual([
    true,
    true,
    false,
  ]);
  f.limit({ ...ANY, byteLimit: 10 });
  expect(await archive.sweep()).toBe(6000);
  expect(existsSync(join(newest, MOVED_OUT_NOTE))).toBe(true);
});

it("leaves the folder untouched and keeps no record when storage refuses a part", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  let calls = 0;
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    archive: (paths, bytes) => {
      calls += 1;
      return calls === 2
        ? Promise.reject(new Error("fixture outage"))
        : f.bridge.archive(paths, bytes);
    },
  };
  const archive = f.archive({ bridge });
  expect(await archive.sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
  expect(readdirSync(join(f.root, WORK_FOLDER_PARTS, BOT))).toEqual([]);
  expect(f.logs.at(-1)).toBe(
    `laterdog home: could not store ${BOT.slice(0, 8)}'s work folder: fixture outage`,
  );
  const kept: WorkFolderBridge = {
    ...f.bridge,
    archive: async () => ({
      archived: 0,
      bytes: 0,
      skipped: [{ path: "x", why: "open-or-unknown" }],
    }),
  };
  expect(await f.archive({ bridge: kept }).sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(f.logs.at(-1)).toContain("open-or-unknown");
});

it("does not clear a folder that changed while it was being stored", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  let touched = false;
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    archive: async (paths, bytes) => {
      if (!touched) put(join(dir, "src/late.ts"), "export const late = true;\n");
      touched = true;
      return f.bridge.archive(paths, bytes);
    },
  };
  const archive = f.archive({ bridge });
  expect(await archive.sweep()).toBe(0);
  expect(readFileSync(join(dir, "src/late.ts"), "utf8")).toBe("export const late = true;\n");
  expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(false);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
  expect(f.logs.at(-1)).toContain("the chat woke or the folder changed");
});

it("stops storing as soon as the chat wakes, and the turn finds its folder as it was", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  let parts = 0;
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    archive: async (paths, bytes) => {
      parts += 1;
      if (parts === 1) f.chats.set(THREAD, { ...f.chats.get(THREAD)!, busy: true });
      return f.bridge.archive(paths, bytes);
    },
  };
  const archive = f.archive({ bridge });
  const sweeping = archive.sweep();
  const turn = archive.beforeTurn(BOT, THREAD);
  expect(await sweeping).toBe(0);
  expect(await turn).toBe(true);
  expect(parts).toBe(1);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("keeps the turn pending while storage cannot give a part back, then proceeds, saying so once", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  let attempts = 0;
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    restoreContaining: (needles) => {
      attempts += 1;
      return attempts <= 2
        ? Promise.reject(new Error("fixture outage"))
        : f.bridge.restoreContaining(needles);
    },
  };
  const archive = f.archive({ bridge });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
  expect(f.logs.filter((line) => line.includes("is not back yet"))).toHaveLength(1);
  expect(attempts).toBeGreaterThan(2);
});

it("a turn that is cancelled while its folder is away stops waiting", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    restoreContaining: () => Promise.reject(new Error("fixture outage")),
  };
  let checks = 0;
  expect(
    await f.archive({ bridge }).beforeTurn(BOT, THREAD, () => {
      checks += 1;
      return checks < 4;
    }),
  ).toBe(false);
  expect(readdirSync(dir)).toEqual([MOVED_OUT_NOTE]);
});

it("makes room before it brings a folder back, and waits while there is none", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  let room = false;
  let made = 0;
  const asked: number[] = [];
  const archive = f.archive({
    room: (bytes) => {
      asked.push(bytes);
      return room;
    },
    makeRoom: async () => {
      made += 1;
      if (made === 3) room = true;
    },
  });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(made).toBe(3);
  expect(asked.every((bytes) => bytes > 20_000)).toBe(true);
  expect(tree(dir)).toEqual(original);
  expect(f.logs.filter((line) => line.includes("no room to bring"))).toHaveLength(1);
});

it("restores a folder after a stop between storing it and clearing it", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  const records = JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"));
  records[`${BOT}/${THREAD}`].cleared = false;
  writeFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), JSON.stringify(records));
  rmSync(join(dir, MOVED_OUT_NOTE));
  put(join(dir, "src/index.ts"), "export const answer = 42;\n");
  const archive = f.archive();
  await archive.sweep();
  expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toBe("export const answer = 42;\n");
  expect(archive.movedOut(BOT, THREAD)).toMatchObject({ cleared: false });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
});

it("forgets the record of a chat whose folder is gone", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const archive = f.archive();
  await archive.sweep();
  rmSync(dir, { recursive: true });
  f.chats.delete(THREAD);
  await archive.sweep();
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
});

it("stores folders after three quiet days while the disk is calm and sooner at every lower rung", () => {
  const disk = (freeShare: number) => ({
    totalBytes: 20 * GB,
    freeBytes: Math.round(20 * GB * freeShare),
  });
  expect(workFolderSweep(null)).toBe(CALM_WORK_FOLDERS);
  expect(workFolderSweep(disk(0.4))).toBe(CALM_WORK_FOLDERS);
  expect(CALM_WORK_FOLDERS).toMatchObject({ idleMs: 3 * DAY, minBytes: 5 * MB, minFiles: 200 });
  expect(
    PRESSURE_WORK_FOLDERS.map((step) => DISK_RUNGS.find((rung) => rung.rung === step.from)!.name),
  ).toEqual(["sweep", "move", "refuse", "floor"]);
  const ladder = [
    CALM_WORK_FOLDERS,
    workFolderSweep(disk(0.2)),
    workFolderSweep(disk(0.14)),
    workFolderSweep(disk(0.08)),
    workFolderSweep(disk(0.02)),
  ];
  expect(new Set(ladder).size).toBe(5);
  for (let at = 1; at < ladder.length; at++) {
    expect(ladder[at]!.idleMs, `idle at step ${at}`).toBeLessThan(ladder[at - 1]!.idleMs);
    expect(ladder[at]!.byteLimit, `bytes at step ${at}`).toBeGreaterThan(ladder[at - 1]!.byteLimit);
  }
  expect(roomFor(null, 5 * GB)).toBe(true);
  expect(roomFor({ totalBytes: 19.2 * GB, freeBytes: 3 * GB }, 1.5 * GB)).toBe(true);
  expect(roomFor({ totalBytes: 19.2 * GB, freeBytes: 3 * GB }, 2.5 * GB)).toBe(false);
});

it("writes a note a person or a dog can read in the folder's place", () => {
  const note = movedOutNote({
    movedAt: Date.UTC(2026, 10, 24, 21, 0),
    bytes: 182 * MB,
    files: 11_421,
  });
  expect(note).toContain("11421 file(s), 182 MB");
  expect(note).toContain("2026-11-24");
  expect(note).toContain("come back by themselves when the chat's next turn starts");
});

it("leaves a linked workspace root and everything it points to untouched", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  const outside = join(f.root, "outside-workspaces");
  project(outside);
  const original = tree(outside);
  rmSync(dir, { recursive: true });
  symlinkSync(outside, dir, "dir");
  const archive = f.archive();
  expect(await archive.sweep()).toBe(0);
  expect(tree(outside)).toEqual(original);
  expect(lstatSync(dir).isSymbolicLink()).toBe(true);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("detects same-size rewrites even when another file has the newest timestamp", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const old = new Date(Date.now() - 5 * DAY);
  utimesSync(join(dir, "README.md"), old, old);
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    archive: async (paths, bytes) => {
      const result = await f.bridge.archive(paths, bytes);
      put(join(dir, "README.md"), "# a newer project\n");
      utimesSync(join(dir, "README.md"), old, old);
      return result;
    },
  };
  const archive = f.archive({ bridge, partBytes: 1024 * 1024 });
  expect(await archive.sweep()).toBe(0);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# a newer project\n");
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("preserves files written after an interrupted clear instead of clearing them on restart", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const records = JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"));
  records[`${BOT}/${THREAD}`].cleared = false;
  writeFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), JSON.stringify(records));
  put(join(dir, "new-work.md"), "written after the stop\n");
  put(join(dir, "README.md"), "# keep my new work\n");
  const archive = f.archive();
  await archive.sweep();
  expect(readFileSync(join(dir, "new-work.md"), "utf8")).toBe("written after the stop\n");
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# keep my new work\n");
  expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toBe("export const answer = 42;\n");
});

it("keeps a known chat's archive record when its local folder is missing", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  rmSync(dir, { recursive: true });
  const archive = f.archive();
  await archive.sweep();
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
});

it("refuses malformed records and part traversal before using any paths", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const records = JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"));
  records[`${BOT}/${THREAD}`].parts[0].name = "../../outside.tar";
  writeFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), JSON.stringify(records));
  expect(() => f.archive().status()).toThrow(/invalid work folder record/);
});

it("does not replace a damaged record file with an empty index", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  writeFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "{broken");
  await expect(f.archive().sweep()).rejects.toThrow();
  expect(tree(dir)).toEqual(original);
  expect(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8")).toBe("{broken");
});

it("waits for an in-flight archive before allowing the next turn to use the folder", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    archive: async (paths, bytes) => {
      entered();
      await held;
      return f.bridge.archive(paths, bytes);
    },
  };
  const archive = f.archive({ bridge });
  const sweeping = archive.sweep();
  await started;
  let proceeded = false;
  const turn = archive.beforeTurn(BOT, THREAD).then((result) => {
    proceeded = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const proceededWhileHeld = proceeded;
  release();
  await sweeping;
  expect(await turn).toBe(true);
  expect(proceededWhileHeld).toBe(false);
  expect(tree(dir)).toEqual(original);
});

it("restores a preexisting file named like the storage note", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  put(join(dir, MOVED_OUT_NOTE), "the person's own file\n");
  const original = tree(dir);
  const archive = f.archive();
  await archive.sweep();
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
});

it("keeps a storage note that was replaced with new work while the files were away", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const archive = f.archive();
  await archive.sweep();
  put(join(dir, MOVED_OUT_NOTE), "new work belongs here\n");
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(readFileSync(join(dir, MOVED_OUT_NOTE), "utf8")).toBe("new work belongs here\n");
});

it("keeps existing work even if its file timestamp was backdated", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const archive = f.archive();
  await archive.sweep();
  put(join(dir, "README.md"), "a new file with an old timestamp\n");
  const old = new Date(Date.now() - 30 * DAY);
  utimesSync(join(dir, "README.md"), old, old);
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("a new file with an old timestamp\n");
});

it("does not follow an existing directory link when bringing files back", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const archive = f.archive();
  await archive.sweep();
  const outside = join(f.root, "outside-restore");
  put(join(outside, "keep.md"), "outside must stay untouched\n");
  const original = tree(outside);
  symlinkSync(outside, join(dir, "src"), "dir");
  let checks = 0;
  expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 4)).toBe(false);
  expect(tree(outside)).toEqual(original);
  expect(lstatSync(join(dir, "src")).isSymbolicLink()).toBe(true);
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
});

it("preserves archived permissions when the home has a private umask", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive();
  await archive.sweep();
  const prior = process.umask(0o077);
  try {
    expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
    expect(tree(dir)).toEqual(original);
  } finally {
    process.umask(prior);
  }
});

it("recovers a corrupt cached part of the right size without unpacking it", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  let damaged = false;
  let attempts = 0;
  const bridge: WorkFolderBridge = {
    ...f.bridge,
    restoreContaining: async (names) => {
      attempts += 1;
      const result = await f.bridge.restoreContaining(names);
      if (!damaged) {
        const path = join(f.root, WORK_FOLDER_PARTS, BOT, names[0]!);
        const bytes = readFileSync(path);
        bytes[0] = bytes[0]! ^ 1;
        writeFileSync(path, bytes);
        damaged = true;
      }
      return result;
    },
  };
  const archive = f.archive({ bridge });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
  expect(attempts).toBeGreaterThan(1);
  expect(f.logs.filter((line) => line.includes("is not back yet"))).toHaveLength(1);
});

it("keeps originals when the archive cannot durably save its index", async () => {
  const storage = memory();
  storage.putArchiveIndex = async () => {
    throw new Error("index save failed");
  };
  const f = await fixture(storage);
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive();
  expect(await archive.sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("keeps originals when the archive index cannot be read back", async () => {
  const storage = memory();
  storage.archiveIndex = async () => null;
  const f = await fixture(storage);
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive();
  expect(await archive.sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("keeps originals when uploaded archive bytes cannot be read back intact", async () => {
  const storage = memory();
  const get = storage.getArchived;
  storage.getArchived = async (hash) => {
    const bytes = new Uint8Array(await get(hash));
    bytes[0] = bytes[0]! ^ 1;
    return bytes;
  };
  const f = await fixture(storage);
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive();
  expect(await archive.sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
});

it("recovers after the archive service itself restarts using only durable state", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  const restarted = await serveArchive(createArchiver({ root: f.root, store: f.storage }), {
    token: "work-folder-restarted",
  });
  cleanups.push(restarted.close);
  const bridge = logArchiveBridge(restarted.url, "work-folder-restarted") as WorkFolderBridge;
  expect(await f.archive({ bridge }).beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
});

it("leaves originals alone when tar cannot start", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  const archive = f.archive({ tar: join(f.root, "missing-tar") });
  expect(await archive.sweep()).toBe(0);
  expect(tree(dir)).toEqual(original);
  expect(archive.movedOut(BOT, THREAD)).toBeNull();
  expect(f.logs.at(-1)).toContain("ENOENT");
});

it("retains the saved record when tar cannot start a restore", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const archive = f.archive({ tar: join(f.root, "missing-tar") });
  let checks = 0;
  expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 3)).toBe(false);
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
  expect(f.logs.some((line) => line.includes("is not back yet"))).toBe(true);
});

it("retains a recoverable record if syncing newly recreated parent directories fails", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  const original = tree(dir);
  await f.archive().sweep();
  renameSync(dirname(dir), join(f.root, "saved-bot-folder"));
  const synced: string[] = [];
  const archive = f.archive({
    syncDirectory: async (path) => {
      synced.push(path);
      if (path === f.workspacesDir) throw new Error("parent sync failed");
    },
  });
  let checks = 0;
  expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 2)).toBe(false);
  expect(synced).toContain(dir);
  expect(synced).toContain(dirname(dir));
  expect(synced).toContain(f.workspacesDir);
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
  expect(JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"))).toHaveProperty(
    `${BOT}/${THREAD}`,
  );
  const restarted = f.archive();
  expect(await restarted.beforeTurn(BOT, THREAD)).toBe(true);
  expect(tree(dir)).toEqual(original);
  expect(restarted.movedOut(BOT, THREAD)).toBeNull();
});

it("keeps restore scratch private when a stored folder is shared-readable", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  chmodSync(dir, 0o777);
  await f.archive().sweep();
  const observed: number[] = [];
  const archive = f.archive({
    syncDirectory: async () => {
      for (const name of readdirSync(dirname(dir)).filter((name) =>
        name.startsWith(".restoring-"),
      )) {
        observed.push(lstatSync(join(dirname(dir), name)).mode & 0o077);
      }
    },
  });
  expect(await archive.beforeTurn(BOT, THREAD)).toBe(true);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((mode) => mode === 0)).toBe(true);
});

it("keeps the storage note when a restore conflicts with a current directory link", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const outside = join(f.root, "note-conflict-outside");
  put(join(outside, "keep.md"), "keep outside\n");
  symlinkSync(outside, join(dir, "src"), "dir");
  const archive = f.archive();
  const record = archive.movedOut(BOT, THREAD)!;
  let checks = 0;
  expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 2)).toBe(false);
  expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(true);
  expect(readFileSync(join(dir, MOVED_OUT_NOTE), "utf8")).toBe(movedOutNote(record));
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
});

it("keeps the storage note when restored parent directories cannot be synced", async () => {
  const f = await fixture();
  const dir = f.chat(THREAD);
  project(dir);
  await f.archive().sweep();
  const archive = f.archive({
    syncDirectory: async (path) => {
      if (path === f.workspacesDir) throw new Error("parent sync refused");
    },
  });
  const record = archive.movedOut(BOT, THREAD)!;
  let checks = 0;
  expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 2)).toBe(false);
  expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(true);
  expect(readFileSync(join(dir, MOVED_OUT_NOTE), "utf8")).toBe(movedOutNote(record));
  expect(archive.movedOut(BOT, THREAD)).not.toBeNull();
});

it.each(["generated", "archived", "current", "linked"])(
  "keeps the recovery record and %s note after a post-note parent sync fails",
  async (kind) => {
    const f = await fixture();
    const dir = f.chat(THREAD);
    project(dir);
    if (kind === "archived") put(join(dir, MOVED_OUT_NOTE), "an archived user note\n");
    await f.archive().sweep();
    const outside = join(f.root, "current-note.md");
    put(outside, "a linked user note\n");
    let parentSyncs = 0;
    let failedAfterRemoval = false;
    const archive = f.archive({
      syncDirectory: async (path) => {
        if (path !== f.workspacesDir || ++parentSyncs !== 2) return;
        failedAfterRemoval =
          kind === "archived"
            ? readFileSync(join(dir, MOVED_OUT_NOTE), "utf8") === "an archived user note\n"
            : !existsSync(join(dir, MOVED_OUT_NOTE));
        if (kind === "current") put(join(dir, MOVED_OUT_NOTE), "a current user note\n");
        if (kind === "linked") symlinkSync(outside, join(dir, MOVED_OUT_NOTE));
        throw new Error("post-note parent sync failed");
      },
    });
    const record = archive.movedOut(BOT, THREAD)!;
    let checks = 0;
    expect(await archive.beforeTurn(BOT, THREAD, () => ++checks < 2)).toBe(false);
    expect(parentSyncs).toBe(2);
    expect(failedAfterRemoval).toBe(true);
    expect(archive.movedOut(BOT, THREAD)).toEqual(record);
    expect(JSON.parse(readFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), "utf8"))).toHaveProperty(
      `${BOT}/${THREAD}`,
    );
    expect(existsSync(join(dir, MOVED_OUT_NOTE))).toBe(true);
    const expected =
      kind === "archived"
        ? "an archived user note\n"
        : kind === "current"
          ? "a current user note\n"
          : kind === "linked"
            ? "a linked user note\n"
            : movedOutNote(record);
    expect(readFileSync(join(dir, MOVED_OUT_NOTE), "utf8")).toBe(expected);
    if (kind === "linked") expect(lstatSync(join(dir, MOVED_OUT_NOTE)).isSymbolicLink()).toBe(true);
    expect(await f.archive().beforeTurn(BOT, THREAD)).toBe(true);
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toBe("export const answer = 42;\n");
  },
);
