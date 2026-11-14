import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AWAY_MARKER, AWAY_RULES, awayVerdict, chatFolders, createAwayPlanner, measureAwayPlan, measureFolder, planAway, recentComputerRunFolders,
  type ChatState, type FolderMeasure, type MeasuredChat,
} from "./folder-away-plan.ts";

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Date.UTC(2026, 10, 14);
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "away-plan-")); made.push(dir); return dir; };

function file(path: string, bytes: number, at = NOW - 60 * DAY) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 3));
  utimesSync(path, new Date(at), new Date(at));
}

const idle: ChatState = { exists: true, inUse: false, routineSoon: false, computerRunRecent: false, lastUsedAt: NOW - 40 * DAY };
const folder = (bytes: number, newestAt: number | null = NOW - 40 * DAY): FolderMeasure => ({ bytes, carriedBytes: bytes, leftOutBytes: 0, files: 3, newestAt, away: false, complete: true });

describe("which chat folders qualify to move", () => {
  it("moves a chat untouched for 30 days and holds back anything in use, due, recent, small or unaccounted for", () => {
    expect(awayVerdict(idle, folder(50 * MB), NOW)).toBe("moves");
    expect(awayVerdict({ ...idle, inUse: true }, folder(50 * MB), NOW)).toBe("in-use");
    expect(awayVerdict({ ...idle, routineSoon: true }, folder(50 * MB), NOW)).toBe("routine-soon");
    expect(awayVerdict({ ...idle, computerRunRecent: true }, folder(50 * MB), NOW)).toBe("computer-run-recent");
    expect(awayVerdict(idle, folder(MB - 1), NOW)).toBe("too-small");
    expect(awayVerdict({ ...idle, exists: false }, folder(50 * MB), NOW)).toBe("no-chat");
    expect(awayVerdict(idle, { ...folder(50 * MB), away: true }, NOW)).toBe("already-away");
    expect(awayVerdict(idle, { ...folder(50 * MB), complete: false }, NOW)).toBe("not-fully-measured");
    expect(awayVerdict({ ...idle, lastUsedAt: null }, folder(50 * MB), NOW)).toBe("used-recently");
  });

  it("only lets pressure move chats idle for between 7 and 30 days, and never ones changed this week", () => {
    expect(awayVerdict({ ...idle, lastUsedAt: NOW - 10 * DAY }, folder(50 * MB), NOW)).toBe("would-move-under-pressure");
    expect(awayVerdict({ ...idle, lastUsedAt: NOW - 3 * DAY }, folder(50 * MB), NOW)).toBe("used-recently");
    expect(awayVerdict(idle, folder(50 * MB, NOW - 10 * DAY), NOW)).toBe("would-move-under-pressure");
    expect(awayVerdict(idle, folder(50 * MB, NOW - 2 * DAY), NOW)).toBe("changed-recently");
  });
});

describe("the plan", () => {
  const chat = (threadId: string, bytes: number, lastUsedDaysAgo: number): MeasuredChat => ({
    botId: "dog", threadId, chat: { ...idle, lastUsedAt: NOW - lastUsedDaysAgo * DAY }, folder: folder(bytes, NOW - lastUsedDaysAgo * DAY),
  });

  it("leaves pressure alone while a fifth of the disk is free and projects the timer's moves", () => {
    const plan = planAway([chat("a", 2 * GB, 40), chat("b", 1 * GB, 10)], { totalBytes: 20 * GB, freeBytes: 5 * GB }, NOW, 7);
    expect(plan.underPressure).toBe(false);
    expect(plan.totals.byTimer).toEqual({ chats: 1, bytes: 2 * GB });
    expect(plan.totals.byPressure).toEqual({ chats: 0, bytes: 0, passes: 0 });
    expect(plan.projected).toEqual({ freeBytes: 7 * GB, freeShare: 0.35 });
    expect(plan.chats.map((row) => row.verdict)).toEqual(["moves", "would-move-under-pressure"]);
  });

  it("under a fifth free, moves the largest week-idle folders until 30% is free, at most 2 GB a pass", () => {
    const plan = planAway([chat("small", 1.5 * GB, 9), chat("big", 1.8 * GB, 12), chat("old", 0.5 * GB, 45), chat("mid", 1.6 * GB, 8), chat("busy", 3 * GB, 20)].map((row) =>
      row.threadId === "busy" ? { ...row, chat: { ...row.chat, inUse: true } } : row), { totalBytes: 20 * GB, freeBytes: 2.5 * GB }, NOW, 7);
    expect(plan.underPressure).toBe(true);
    const verdicts = Object.fromEntries(plan.chats.map((row) => [row.threadId, row.verdict]));
    expect(verdicts).toEqual({ small: "would-move-under-pressure", big: "moves-under-pressure", old: "moves", mid: "moves-under-pressure", busy: "in-use" });
    expect(plan.totals.byPressure).toMatchObject({ chats: 2, passes: 2 });
    expect(plan.totals.byPressure.bytes).toBeCloseTo(3.4 * GB, 0);
    expect(plan.projected!.freeShare).toBeGreaterThanOrEqual(AWAY_RULES.pressureUntilShare);
  });
});

describe("measuring a chat folder", () => {
  it("counts what the save keeps apart from what it leaves out and spots a folder already away", async () => {
    const root = scratch();
    const dir = join(root, "chat");
    file(join(dir, "notes.txt"), 300_000, NOW - 50 * DAY);
    file(join(dir, ".git", "objects", "pack"), 200_000, NOW - 45 * DAY);
    file(join(dir, "node_modules", "left", "index.js"), 400_000, NOW - DAY);
    file(join(dir, "data.db-wal"), 10_000, NOW - DAY);
    file(join(dir, "held.lock", "inner"), 10_000, NOW - DAY);
    symlinkSync("/etc/hosts", join(dir, "link"));
    const measured = await measureFolder(dir);
    expect(measured).toMatchObject({ files: 2, carriedBytes: 500_000, away: false, complete: true, newestAt: NOW - 45 * DAY });
    expect(measured.leftOutBytes).toBeGreaterThanOrEqual(420_000);
    expect(measured.bytes).toBeGreaterThanOrEqual(measured.carriedBytes + measured.leftOutBytes);
    const away = join(root, "away");
    file(join(away, AWAY_MARKER), 100);
    expect(await measureFolder(away)).toMatchObject({ away: true, bytes: 0 });
    expect(await measureFolder(join(root, "missing"))).toMatchObject({ complete: false });
    expect(await measureFolder(dir, { entries: 2 })).toMatchObject({ complete: false });
  });

  it("finds chat folders by safe ids only and reads recent computer runs", async () => {
    const root = scratch();
    file(join(root, "tasks", "dog-1", "thread-a", "x"), 10);
    file(join(root, "tasks", "dog-1", "bad name", "x"), 10);
    file(join(root, "tasks", "loose-file"), 10);
    expect((await chatFolders(join(root, "tasks"))).map(({ botId, threadId }) => `${botId}/${threadId}`)).toEqual(["dog-1/thread-a"]);
    mkdirSync(join(root, "runs", "dog-1"), { recursive: true });
    writeFileSync(join(root, "runs", "dog-1", "run-0123abcd.json"), JSON.stringify({ folder: "/f/new", startedAt: NOW - 1000 }));
    writeFileSync(join(root, "runs", "dog-1", "run-0123abce.json"), JSON.stringify({ folder: "/f/old", startedAt: NOW - 3 * DAY }));
    writeFileSync(join(root, "runs", "dog-1", "run-0123abcf.json"), "not json");
    expect(await recentComputerRunFolders(join(root, "runs"), "dog-1", NOW - DAY)).toEqual(["/f/new"]);
    expect(await recentComputerRunFolders(join(root, "runs"), "../x", 0)).toEqual([]);
  });
});

describe("the read-only report", () => {
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (at: string) => {
      for (const name of readdirSync(at).sort()) {
        const path = join(at, name);
        const info = statSync(path);
        out.push(`${relative(dir, path)}:${info.size}:${info.mtimeMs}:${info.mode}`);
        if (info.isDirectory()) walk(path);
      }
    };
    walk(dir);
    return out;
  }

  it("changes nothing on disk and answers with ids, sizes and dates only, never file names", async () => {
    const root = scratch();
    const tasks = join(root, "tasks");
    file(join(tasks, "dog-1", "thread-old", "private-plan-for-acme.txt"), 2 * MB, NOW - 60 * DAY);
    file(join(tasks, "dog-1", "thread-run", "build", "out.bin"), 2 * MB, NOW - 60 * DAY);
    file(join(tasks, "dog-2", "thread-new", "draft.md"), 2 * MB, NOW - DAY);
    mkdirSync(join(root, "runs", "dog-1"), { recursive: true });
    writeFileSync(join(root, "runs", "dog-1", "run-0123abcd.json"), JSON.stringify({ folder: join(tasks, "dog-1", "thread-run", "build"), startedAt: NOW - 1000 }));
    const before = snapshot(root);
    const planner = createAwayPlanner({
      tasksDir: tasks, runsDir: join(root, "runs"), now: () => NOW,
      chat: (_botId, threadId) => ({ exists: threadId !== "gone", inUse: false, routineSoon: false, lastUsedAt: threadId === "thread-new" ? NOW - DAY : NOW - 50 * DAY }),
      disk: () => ({ totalBytes: 20 * GB, freeBytes: 3 * GB }),
    });
    expect(planner.measure()).toBe(true);
    expect(planner.measure()).toBe(false);
    const plan = (await planner.settled())!;
    expect(planner.last()).toBe(plan);
    expect(snapshot(root)).toEqual(before);
    expect(Object.fromEntries(plan.chats.map((row) => [row.threadId, row.verdict]))).toEqual({ "thread-old": "moves", "thread-run": "computer-run-recent", "thread-new": "used-recently" });
    expect(plan.totals.byTimer.chats).toBe(1);
    const text = JSON.stringify(plan);
    for (const secret of ["private-plan", "acme", "out.bin", "draft.md", "build", root]) expect(text).not.toContain(secret);
  });

  it("keeps the last plan and says so in its log when a measurement fails", async () => {
    const lines: string[] = [];
    const tasks = scratch();
    file(join(tasks, "dog-1", "thread-a", "x"), 10);
    let fail = false;
    const planner = createAwayPlanner({ tasksDir: tasks, runsDir: scratch(), chat: () => { if (fail) throw new Error("store unavailable"); return idle; }, disk: () => null }, (line) => lines.push(line));
    expect(await measureAwayPlan({ tasksDir: scratch(), runsDir: scratch(), chat: () => idle, disk: () => null })).toMatchObject({ totals: { folders: 0 }, projected: null });
    planner.measure();
    const first = await planner.settled();
    expect(first?.totals.folders).toBe(1);
    fail = true;
    planner.measure();
    expect(await planner.settled()).toBe(first);
    expect(lines).toEqual(["could not measure which chats' files could move: store unavailable"]);
  });
});
