import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createArchiver, serveArchive } from "../runtime/archive.mjs";
import {
  CALM_SWEEP, FIRST_SWEEP_MS, LEAST_IDLE_MS, PLENTY_FREE_BYTES, PRESSURE_SWEEPS, ROOM_KEPT_FREE_BYTES, SAVE_COPY_RESERVE_BYTES, STEADY_WINDOW_MS, SWEEP_CHECK_MS, archiveSweep, pressureRung,
  roomFor, roomToRestore, savesHold, startArchiveSweeps, steadyDisk,
} from "../../../../server/laterdog/archive-pressure.ts";
import { DISK_RUNGS } from "../../../../server/laterdog/disk-ladder.ts";
import { SAVE_STATUS_FRESH_MS, freshSaveStatus, readSaveStatus, savesForStorage, type SaveStatus } from "../../../../server/laterdog/save-status.ts";
import {
  ARCHIVE_BATCH_BYTES, ARCHIVE_BATCH_PATHS, ARCHIVE_CALL_MAX_MS, ARCHIVE_CALL_MS, LogArchiveCoordinator, SWEEP_FAILURES_IN_A_ROW,
  archiveBatches, archiveCallMs, archivedSessionOf, claudeSessionIds, logArchiveBridge, threadLogPaths, type LogArchiveBridge,
} from "../../../../server/laterdog/log-archive.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const disk = (freeShare: number) => ({ totalBytes: 20 * GB, freeBytes: Math.round(20 * GB * freeShare) });
const THREADS = ["thread-pressure-1", "thread-pressure-2", "thread-pressure-3", "thread-pressure-4"];
const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SLUG = "-home-dog-work";
const transcript = (id: string) => `.claude/projects/${SLUG}/${id}.jsonl`;
const eventsOf = (id: string) => threadLogPaths(id)[0];

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archive-pressure-")));
  roots.push(root);
  return root;
}
function put(root: string, path: string, bytes: Buffer | string, agoMs: number) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  const when = new Date(Date.now() - agoMs);
  utimesSync(join(root, path), when, when);
}
function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  return {
    async archiveIndex() { return structuredClone(index); },
    async putArchiveIndex(next: unknown) { index = structuredClone(next); },
    async hasArchived(hash: string) { return blobs.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) { const found = blobs.get(hash); if (!found) throw new Error("missing"); return found; },
  };
}
async function fixture(canRemove: () => Promise<boolean> = async () => true) {
  const root = scratch();
  const archiver = createArchiver({ root, store: memory(), canRemove });
  const service = await serveArchive(archiver, { token: "archive-pressure-fixture" });
  cleanups.push(service.close);
  const bridge = logArchiveBridge(service.url, "archive-pressure-fixture");
  const busy = new Set<string>();
  const cursors: Record<string, Record<string, unknown>> = {};
  const reports: string[] = [];
  const coordinator = (extra: Partial<ConstructorParameters<typeof LogArchiveCoordinator>[0]> = {}) => new LogArchiveCoordinator({
    root, bridge, threads: () => THREADS, idle: id => !busy.has(id), retryMs: 5,
    sessions: id => claudeSessionIds(cursors[id]), report: message => reports.push(message), ...extra,
  });
  return { root, bridge, busy, cursors, reports, coordinator };
}
const here = (root: string, path: string) => existsSync(join(root, path));

it("sweeps as it always did while the disk is calm, and harder at every lower rung", () => {
  expect(archiveSweep(null)).toBe(CALM_SWEEP);
  expect(archiveSweep(disk(0.5))).toBe(CALM_SWEEP);
  expect(archiveSweep(disk(0.3))).toBe(CALM_SWEEP);
  expect(CALM_SWEEP).toMatchObject({ ageMs: 24 * HOUR, sessionAgeMs: 72 * HOUR, byteLimit: 64 * MB, sessionByteLimit: 128 * MB, threadLimit: 100, everyMs: 5 * MINUTE });
  expect(PRESSURE_SWEEPS.map((step) => DISK_RUNGS.find((rung) => rung.rung === step.from)!.name)).toEqual(["sweep", "move", "refuse", "floor"]);
  const ladder = [CALM_SWEEP, archiveSweep(disk(0.2)), archiveSweep(disk(0.14)), archiveSweep(disk(0.08)), archiveSweep(disk(0.02))];
  expect(new Set(ladder).size).toBe(5);
  for (let at = 1; at < ladder.length; at++) {
    const [milder, harder] = [ladder[at - 1]!, ladder[at]!];
    expect(harder.ageMs, `age at step ${at}`).toBeLessThan(milder.ageMs);
    expect(harder.sessionAgeMs, `session age at step ${at}`).toBeLessThan(milder.sessionAgeMs);
    expect(harder.byteLimit, `bytes at step ${at}`).toBeGreaterThan(milder.byteLimit);
    expect(harder.sessionByteLimit, `session bytes at step ${at}`).toBeGreaterThan(milder.sessionByteLimit);
    expect(harder.threadLimit, `threads at step ${at}`).toBeGreaterThan(milder.threadLimit);
    expect(harder.everyMs, `pace at step ${at}`).toBeLessThanOrEqual(milder.everyMs);
    expect(harder.quietMs, `quiet at step ${at}`).toBeLessThanOrEqual(milder.quietMs);
  }
  expect(archiveSweep({ totalBytes: 19.2 * GB, freeBytes: 2.7 * GB })).toBe(ladder[2]);
  expect(archiveSweep({ totalBytes: 19.2 * GB, freeBytes: 0.3 * GB })).toMatchObject({ ageMs: LEAST_IDLE_MS, sessionAgeMs: HOUR, byteLimit: Infinity, sessionByteLimit: Infinity });
});

it("never takes what a chat used in the last half hour, however full the disk is", () => {
  expect(LEAST_IDLE_MS).toBe(30 * MINUTE);
  for (const sweep of [CALM_SWEEP, ...PRESSURE_SWEEPS.map((step) => step.sweep)]) {
    expect(sweep.ageMs).toBeGreaterThanOrEqual(LEAST_IDLE_MS);
    expect(sweep.sessionAgeMs).toBeGreaterThanOrEqual(LEAST_IDLE_MS);
  }
  expect(archiveSweep({ totalBytes: 19.2 * GB, freeBytes: 0 })).toMatchObject({ ageMs: LEAST_IDLE_MS, sessionAgeMs: HOUR });
});

it("says there is room to bring files back while a quarter of a gigabyte stays free, whatever the size of the disk", () => {
  expect(ROOM_KEPT_FREE_BYTES).toBe(256 * MB);
  expect(roomToRestore(null)).toBe(true);
  expect(roomToRestore(disk(0.5))).toBe(true);
  expect(roomToRestore({ totalBytes: 19.2 * GB, freeBytes: 0.3 * GB })).toBe(true);
  expect(roomToRestore({ totalBytes: 19.2 * GB, freeBytes: 0.2 * GB })).toBe(false);
  expect(roomToRestore({ totalBytes: 228 * GB, freeBytes: 11 * GB })).toBe(true);
  expect(roomFor({ totalBytes: 19.2 * GB, freeBytes: 3 * GB }, 2.5 * GB)).toBe(true);
  expect(roomFor({ totalBytes: 19.2 * GB, freeBytes: 3 * GB }, 2.8 * GB)).toBe(false);
});

it("treats a disk with plenty of free space as calm however small its free share is", () => {
  const large = { totalBytes: 228 * GB, freeBytes: 11.6 * GB };
  expect(pressureRung(large)).toBe(0);
  expect(archiveSweep(large)).toBe(CALM_SWEEP);
  expect(pressureRung({ totalBytes: 228 * GB, freeBytes: PLENTY_FREE_BYTES - 1 })).toBeGreaterThan(0);
  expect(archiveSweep({ totalBytes: 19.2 * GB, freeBytes: 4.5 * GB })).not.toBe(CALM_SWEEP);
  expect(archiveSweep({ totalBytes: 19.2 * GB, freeBytes: 6 * GB })).toBe(CALM_SWEEP);
});

it("counts the copy a save makes of the largest database, and its reserve, as space the home cannot use", () => {
  const root = scratch();
  expect(savesHold(root)).toBe(0);
  expect(savesHold(join(root, "missing"))).toBe(0);
  writeFileSync(join(root, "messages.db"), Buffer.alloc(3000));
  writeFileSync(join(root, "messages.db-wal"), Buffer.alloc(500));
  writeFileSync(join(root, "small.sqlite"), Buffer.alloc(100));
  writeFileSync(join(root, "notes.txt"), Buffer.alloc(9000));
  mkdirSync(join(root, "folder.db"));
  expect(savesHold(root)).toBe(3500 + SAVE_COPY_RESERVE_BYTES);
});

function saveStatus(fields: Partial<SaveStatus> = {}): SaveStatus {
  return { version: 1, state: "saved", final: false, startedAt: 1_000, updatedAt: 2_000, endedAt: 2_000, durationMs: 1_000, heldOnDiskBytes: 0, heldInMemoryBytes: 1_070 * MB, copies: [], ...fields };
}

it("holds only the reserve while the last save, recent, copied its databases to memory", () => {
  const root = scratch();
  writeFileSync(join(root, "messages.db"), Buffer.alloc(3000));
  writeFileSync(join(root, "messages.db-wal"), Buffer.alloc(500));
  const now = 2_000 + SAVE_STATUS_FRESH_MS;
  expect(savesHold(root, saveStatus(), now)).toBe(SAVE_COPY_RESERVE_BYTES);
  expect(savesHold(root, saveStatus({ state: "saving", heldOnDiskBytes: 0 }), now)).toBe(SAVE_COPY_RESERVE_BYTES);
  expect(savesHold(join(root, "missing"), saveStatus(), now)).toBe(SAVE_COPY_RESERVE_BYTES);
});

it("holds what a recent save copied to disk, including a save still copying", () => {
  const root = scratch();
  writeFileSync(join(root, "messages.db"), Buffer.alloc(3000));
  expect(savesHold(root, saveStatus({ heldOnDiskBytes: 567 * MB }), 2_000)).toBe(567 * MB + SAVE_COPY_RESERVE_BYTES);
  expect(savesHold(root, saveStatus({ state: "saving", copying: "messages.db", heldOnDiskBytes: 1_070 * MB }), 2_000)).toBe(1_070 * MB + SAVE_COPY_RESERVE_BYTES);
});

it("falls back to the largest database when the save status is missing, stale, failed, from the future or unreadable", () => {
  const root = scratch();
  writeFileSync(join(root, "messages.db"), Buffer.alloc(3000));
  writeFileSync(join(root, "messages.db-wal"), Buffer.alloc(500));
  const today = 3500 + SAVE_COPY_RESERVE_BYTES;
  expect(savesHold(root, null, 2_000)).toBe(today);
  expect(savesHold(root, saveStatus(), 2_000 + SAVE_STATUS_FRESH_MS + 1)).toBe(today);
  expect(savesHold(root, saveStatus({ state: "failed" }), 2_000)).toBe(today);
  expect(savesHold(root, saveStatus({ updatedAt: 2_000 + SAVE_STATUS_FRESH_MS + 1 }), 0)).toBe(today);
  const file = join(root, "save-status.json");
  expect(readSaveStatus(file)).toBeNull();
  for (const body of ["not json", "{}", JSON.stringify({ ...saveStatus(), version: 2 }), JSON.stringify({ ...saveStatus(), heldOnDiskBytes: -1 }), JSON.stringify({ ...saveStatus(), state: "done" }), JSON.stringify({ ...saveStatus(), copies: null })]) {
    writeFileSync(file, body);
    expect(readSaveStatus(file)).toBeNull();
    expect(savesHold(root, readSaveStatus(file), 2_000)).toBe(today);
  }
  expect(freshSaveStatus(null)).toBe(false);
});

it("shows the last save in the storage status, marked fresh or not", () => {
  const root = scratch();
  const file = join(root, "save-status.json");
  expect(savesForStorage(file, 2_000)).toBeNull();
  writeFileSync(file, JSON.stringify(saveStatus()));
  expect(savesForStorage(file, 2_000)).toEqual({ ...saveStatus(), fresh: true });
  expect(savesForStorage(file, 2_000 + SAVE_STATUS_FRESH_MS + 1)).toMatchObject({ state: "saved", fresh: false });
});

it("reads the disk as it stands between saves: the most free space of the last minute and a half, less what saves hold", () => {
  const MIB = 1024 ** 2;
  let clock = 1_000_000;
  let free = 2700 * MIB;
  let held = 1200 * MIB;
  const read = steadyDisk(() => ({ totalBytes: 19_200 * MIB, freeBytes: free }), () => held, { now: () => clock });
  expect(read()).toEqual({ totalBytes: 19_200 * MIB, freeBytes: 1500 * MIB });
  clock += 15_000;
  free = 1800 * MIB;
  expect(read()!.freeBytes).toBe(1500 * MIB);
  clock += STEADY_WINDOW_MS;
  expect(read()!.freeBytes).toBe(600 * MIB);
  held = 5000 * MIB;
  expect(read()!.freeBytes).toBe(0);
  expect(steadyDisk(() => null)()).toBeNull();
  expect(archiveSweep(steadyDisk(() => ({ totalBytes: 19_200 * MIB, freeBytes: 2700 * MIB }), () => 1230 * MIB)())).toBe(archiveSweep(disk(0.08)));
  expect(roomToRestore(steadyDisk(() => ({ totalBytes: 19_200 * MIB, freeBytes: 2000 * MIB }), () => 1230 * MIB)())).toBe(true);
  expect(roomToRestore(steadyDisk(() => ({ totalBytes: 19_200 * MIB, freeBytes: 1400 * MIB }), () => 1230 * MIB)())).toBe(false);
});

it("gives one archive call more time the more bytes it carries, up to a ceiling", () => {
  expect(archiveCallMs()).toBe(ARCHIVE_CALL_MS);
  expect(archiveCallMs(32 * MB)).toBe(ARCHIVE_CALL_MS + 64_000);
  expect(archiveCallMs(600 * MB)).toBeGreaterThan(10 * MINUTE);
  expect(archiveCallMs(1024 * GB)).toBe(ARCHIVE_CALL_MAX_MS);
});

it("splits a session's files into calls of bounded size, keeping their order and sending an oversized file alone", () => {
  const files = Array.from({ length: 120 }, (_, at) => ({ path: `f${at}`, size: 10 }));
  const split = archiveBatches(files);
  expect(split.map((batch) => batch.length)).toEqual([ARCHIVE_BATCH_PATHS, ARCHIVE_BATCH_PATHS, 20]);
  expect(split.flat()).toEqual(files);
  const heavy = [{ path: "a", size: 20 * MB }, { path: "b", size: 20 * MB }, { path: "huge", size: 5 * ARCHIVE_BATCH_BYTES }, { path: "c", size: 1 }];
  expect(archiveBatches(heavy).map((batch) => batch.map((file) => file.path))).toEqual([["a"], ["b"], ["huge"], ["c"]]);
  expect(archiveBatches([])).toEqual([]);
});

it("reads the engine session out of an archived path and nothing out of any other path", () => {
  expect(archivedSessionOf(transcript(SESSION))).toBe(SESSION);
  expect(archivedSessionOf(`.laterdog/providers/claude-2/projects/${SLUG}/${SESSION}/tool-results/shot.jpg`)).toBe(SESSION);
  expect(archivedSessionOf(eventsOf(THREADS[0]!))).toBeNull();
  expect(archivedSessionOf(`.claude/projects/${SLUG}/${SESSION}.jsonl.bak`)).toBeNull();
});

it("archives younger logs and sessions only when the sweep it is given asks for them", async () => {
  const f = await fixture();
  f.cursors[THREADS[0]!] = { claude: SESSION };
  put(f.root, eventsOf(THREADS[0]!), "three hours old\n", 3 * HOUR);
  put(f.root, transcript(SESSION), "eight hours old\n", 8 * HOUR);
  let limits = { ...CALM_SWEEP };
  const coordinator = f.coordinator({ sweep: () => limits });
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  expect(here(f.root, transcript(SESSION))).toBe(true);
  expect(f.reports).toEqual([]);
  limits = { ...archiveSweep(disk(0.14)) };
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(false);
  expect(here(f.root, transcript(SESSION))).toBe(false);
  expect(f.reports[0]).toBe("now archiving logs idle 2 h and engine sessions idle 6 h");
  expect(f.reports[1]).toMatch(/^archived 1 logs \/ 16 bytes and 1 engine session files \/ 16 bytes; free disk \d+ -> \d+ bytes$/);
  f.busy.add(THREADS[0]!);
  expect(await coordinator.beforeTurn(THREADS[0]!, () => true)).toBe(true);
  expect(readFileSync(join(f.root, eventsOf(THREADS[0]!)), "utf8")).toBe("three hours old\n");
  expect(readFileSync(join(f.root, transcript(SESSION)), "utf8")).toBe("eight hours old\n");
});

it("keeps a chat that worked minutes ago on a nearly full disk, and archives its log after half an hour idle and its session after an hour", async () => {
  const f = await fixture();
  let clock = Date.now();
  f.cursors[THREADS[0]!] = { claude: SESSION };
  put(f.root, eventsOf(THREADS[0]!), "a turn ended three minutes ago\n", 3 * MINUTE);
  put(f.root, transcript(SESSION), "and so did its engine session\n", 3 * MINUTE);
  const coordinator = f.coordinator({ now: () => clock, sweep: () => archiveSweep(disk(0.02)) });
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  expect(here(f.root, transcript(SESSION))).toBe(true);
  clock += 20 * MINUTE;
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  expect(here(f.root, transcript(SESSION))).toBe(true);
  clock += 10 * MINUTE;
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(false);
  expect(here(f.root, transcript(SESSION))).toBe(true);
  clock += 30 * MINUTE;
  await coordinator.scan();
  expect(here(f.root, transcript(SESSION))).toBe(false);
});

it("starts a turn at once on a home with two gigabytes free beside a one-gigabyte database, bringing the chat's archived log back", async () => {
  const f = await fixture();
  put(f.root, eventsOf(THREADS[0]!), "archived while the chat was idle\n", 30 * HOUR);
  await f.coordinator().scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(false);
  const GIB = 1024 ** 3;
  const home = steadyDisk(() => ({ totalBytes: 17.91 * GIB, freeBytes: 2.02 * GIB }), () => 1.26 * GIB);
  expect(archiveSweep(home())).toBe(PRESSURE_SWEEPS.at(-1)!.sweep);
  const coordinator = f.coordinator({ room: () => roomToRestore(home()), sweep: () => archiveSweep(home()) });
  f.busy.add(THREADS[0]!);
  expect(await coordinator.beforeTurn(THREADS[0]!, () => true)).toBe(true);
  expect(readFileSync(join(f.root, eventsOf(THREADS[0]!)), "utf8")).toBe("archived while the chat was idle\n");
  expect(f.reports.filter((line) => line.startsWith("no room"))).toEqual([]);
});

it("leaves a chat alone for the quiet time after someone read it or a turn began, then archives it", async () => {
  const f = await fixture();
  let clock = Date.now();
  put(f.root, eventsOf(THREADS[0]!), "read a moment ago\n", 30 * HOUR);
  put(f.root, eventsOf(THREADS[1]!), "nobody is looking\n", 30 * HOUR);
  const coordinator = f.coordinator({ now: () => clock, sweep: () => ({ quietMs: 10 * MINUTE }) });
  expect(await coordinator.read(THREADS[0]!, () => "read")).toBe("read");
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  expect(here(f.root, eventsOf(THREADS[1]!))).toBe(false);
  clock += 9 * MINUTE;
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  clock += 2 * MINUTE;
  await coordinator.scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(false);
});

it("keeps a session whose chat was just read, even when another idle chat shares it", async () => {
  const f = await fixture();
  f.cursors[THREADS[0]!] = { claude: SESSION };
  f.cursors[THREADS[1]!] = { claude: SESSION };
  put(f.root, transcript(SESSION), "shared\n", 100 * HOUR);
  const coordinator = f.coordinator({ sweep: () => ({ quietMs: 10 * MINUTE }) });
  await coordinator.readMany([THREADS[1]!], () => null);
  await coordinator.scan();
  expect(here(f.root, transcript(SESSION))).toBe(true);
});

it("sends a large session in several bounded calls and archives every file", async () => {
  const f = await fixture();
  f.cursors[THREADS[0]!] = { claude: SESSION };
  put(f.root, transcript(SESSION), "transcript\n", 100 * HOUR);
  const shots = Array.from({ length: 119 }, (_, at) => `.claude/projects/${SLUG}/${SESSION}/tool-results/shot-${String(at).padStart(3, "0")}.jpg`);
  for (const shot of shots) put(f.root, shot, "jpg", 100 * HOUR);
  const calls: Array<{ paths: number; bytes: number | undefined }> = [];
  const bridge: LogArchiveBridge = { ...f.bridge, archive: (paths, bytes) => { calls.push({ paths: paths.length, bytes }); return f.bridge.archive(paths, bytes); } };
  await f.coordinator({ bridge }).scan();
  expect(calls.map((call) => call.paths)).toEqual([ARCHIVE_BATCH_PATHS, ARCHIVE_BATCH_PATHS, 20]);
  expect(calls.every((call) => typeof call.bytes === "number" && call.bytes > 0)).toBe(true);
  for (const path of [transcript(SESSION), ...shots]) expect(here(f.root, path), path).toBe(false);
  expect(f.reports.at(-1)).toMatch(/^archived 0 logs \/ 0 bytes and 120 engine session files \/ \d+ bytes; free disk/);
});

it("says why it kept a file the archive service would not remove", async () => {
  const f = await fixture(async () => false);
  put(f.root, eventsOf(THREADS[0]!), "held open\n", 30 * HOUR);
  await f.coordinator().scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(true);
  expect(f.reports).toHaveLength(1);
  expect(f.reports[0]).toMatch(/^archived 0 logs \/ 0 bytes and 0 engine session files \/ 0 bytes; free disk \d+ -> \d+ bytes; kept 1 open-or-unknown$/);
});

it("carries on past one chat whose archive fails and names it", async () => {
  const f = await fixture();
  for (const id of THREADS) put(f.root, eventsOf(id), `${id}\n`, 30 * HOUR);
  const bridge: LogArchiveBridge = { ...f.bridge, archive: (paths, bytes) => paths[0] === eventsOf(THREADS[1]!) ? Promise.reject(new Error("fixture outage")) : f.bridge.archive(paths, bytes) };
  await f.coordinator({ bridge }).scan();
  expect(THREADS.map((id) => here(f.root, eventsOf(id)))).toEqual([false, true, false, false]);
  expect(f.reports.at(-1)).toMatch(/^archived 3 logs \/ \d+ bytes and 0 engine session files \/ 0 bytes; free disk \d+ -> \d+ bytes; 1 failed, first thread-p: fixture outage$/);
});

it("stops a sweep after several failures in a row instead of trying every chat", async () => {
  const f = await fixture();
  const many = Array.from({ length: 12 }, (_, at) => `thread-failing-${String(at).padStart(2, "0")}`);
  for (const id of many) put(f.root, eventsOf(id), `${id}\n`, 30 * HOUR);
  let calls = 0;
  const bridge: LogArchiveBridge = { ...f.bridge, archive: () => { calls += 1; return Promise.reject(new Error("fixture outage")); } };
  await expect(f.coordinator({ bridge, threads: () => many }).scan()).rejects.toThrow("keeps failing");
  expect(calls).toBe(SWEEP_FAILURES_IN_A_ROW);
  expect(f.reports.at(-1)).toContain(`${SWEEP_FAILURES_IN_A_ROW} failed, first thread-f: fixture outage`);
});

it("holds a turn while there is no room to bring its saved files back, makes room, then proceeds", async () => {
  const f = await fixture();
  put(f.root, eventsOf(THREADS[0]!), "needed before the turn\n", 30 * HOUR);
  put(f.root, eventsOf(THREADS[1]!), "x".repeat(4096), 30 * HOUR);
  await f.coordinator({ threads: () => [THREADS[0]!] }).scan();
  expect(here(f.root, eventsOf(THREADS[0]!))).toBe(false);
  let room = false;
  let asked = 0;
  const coordinator = f.coordinator({
    sweep: () => ({ quietMs: 10 * MINUTE }),
    room: () => { asked += 1; if (!here(f.root, eventsOf(THREADS[1]!))) room = true; return room; },
  });
  f.busy.add(THREADS[0]!);
  expect(await coordinator.beforeTurn(THREADS[0]!, () => true)).toBe(true);
  expect(asked).toBeGreaterThan(1);
  expect(here(f.root, eventsOf(THREADS[1]!))).toBe(false);
  expect(readFileSync(join(f.root, eventsOf(THREADS[0]!)), "utf8")).toBe("needed before the turn\n");
  expect(f.reports.filter((line) => line.startsWith("no room"))).toEqual([]);
});

it("keeps the turn pending and says so once while room cannot be made", async () => {
  const f = await fixture();
  put(f.root, eventsOf(THREADS[0]!), "needed before the turn\n", 30 * HOUR);
  await f.coordinator().scan();
  let room = false;
  let checks = 0;
  const coordinator = f.coordinator({ room: () => room });
  f.busy.add(THREADS[0]!);
  const turn = coordinator.beforeTurn(THREADS[0]!, () => { checks += 1; if (checks === 4) room = true; return true; });
  expect(await turn).toBe(true);
  expect(f.reports.filter((line) => line.startsWith("no room"))).toEqual(["no room to bring saved logs back; making room and keeping the pending turn"]);
  expect(readFileSync(join(f.root, eventsOf(THREADS[0]!)), "utf8")).toBe("needed before the turn\n");
});

it("starts a turn at once when the disk is full but nothing of that chat is archived", async () => {
  const f = await fixture();
  put(f.root, eventsOf(THREADS[1]!), "another chat's archived log\n", 30 * HOUR);
  await f.coordinator().scan();
  put(f.root, eventsOf(THREADS[0]!), "already here\n", 0);
  const coordinator = f.coordinator({ room: () => false });
  f.busy.add(THREADS[0]!);
  expect(await coordinator.beforeTurn(THREADS[0]!, () => true)).toBe(true);
  expect(f.reports.filter((line) => line.startsWith("no room"))).toEqual([]);
});

it("starts a turn as before when the archive service cannot say what it holds", async () => {
  const f = await fixture();
  const bridge: LogArchiveBridge = { ...f.bridge, pending: () => Promise.reject(new Error("fixture outage")) };
  f.busy.add(THREADS[0]!);
  expect(await f.coordinator({ bridge, room: () => false }).beforeTurn(THREADS[0]!, () => true)).toBe(true);
  const { pending: _unused, ...older } = f.bridge;
  expect(await f.coordinator({ bridge: older, room: () => false }).beforeTurn(THREADS[0]!, () => true)).toBe(true);
});

it("paces sweeps by the disk: a minute after start and every five while calm, within seconds and every half minute when nearly full", async () => {
  vi.useFakeTimers();
  let free = 0.5;
  const scans: number[] = [];
  const started = Date.now();
  const stop = startArchiveSweeps({ scan: async () => { scans.push(Date.now() - started); }, disk: () => disk(free) });
  await vi.advanceTimersByTimeAsync(FIRST_SWEEP_MS - 1);
  expect(scans).toEqual([]);
  await vi.advanceTimersByTimeAsync(SWEEP_CHECK_MS);
  expect(scans).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(CALM_SWEEP.everyMs - SWEEP_CHECK_MS);
  expect(scans).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2 * SWEEP_CHECK_MS);
  expect(scans).toHaveLength(2);
  free = 0.02;
  await vi.advanceTimersByTimeAsync(3 * SWEEP_CHECK_MS);
  expect(scans).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  expect(scans).toHaveLength(8);
  expect(scans.slice(1).map((at, index) => at - scans[index]!)).toEqual([5 * MINUTE, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
  stop();
  const before = scans.length;
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(scans).toHaveLength(before);
});

it("sweeps within seconds of starting when the home wakes with a nearly full disk, never overlaps, and survives a failing sweep", async () => {
  vi.useFakeTimers();
  let running = 0;
  let most = 0;
  let scans = 0;
  const warned: string[] = [];
  const stop = startArchiveSweeps({
    disk: () => disk(0.01),
    warn: (line) => warned.push(line),
    scan: async () => {
      scans += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2 * MINUTE));
      running -= 1;
      if (scans === 1) throw new Error("fixture outage");
    },
  });
  await vi.advanceTimersByTimeAsync(SWEEP_CHECK_MS);
  expect(scans).toBe(1);
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(most).toBe(1);
  expect(scans).toBeGreaterThanOrEqual(3);
  expect(warned).toEqual(["[log archive] scan deferred"]);
  stop();
});
