import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import * as mdb from "../message-db.ts";
import { Store, type BotRecord, type GroupRecord, type Message, type TaskRecord } from "../store.ts";
import {
  madeForRoutineRun, mainConversation, savedRoutineRuns,
  type ConversationCandidate, type ConversationEvidence, type SavedRoutineRun,
} from "./main-conversation.ts";

const evidence = (written: Record<string, number> = {}, runs: SavedRoutineRun[] = []): ConversationEvidence => ({
  lastWrittenByPerson: new Map(Object.entries(written)),
  madeForRoutineRun: madeForRoutineRun(runs),
});
const thread = (threadId: string, createdAt: number, extra: Partial<ConversationCandidate> = {}): ConversationCandidate =>
  ({ threadId, createdAt, ...extra });

describe("choosing a dog's one conversation from 0.3.41 threads", () => {
  const main = thread("main", 100);
  const fresh = thread("fresh", 300);

  it("keeps the thread it points at when the person wrote there, even when another thread heard from them later", () => {
    expect(mainConversation("fresh", [fresh, main], evidence({ fresh: 350, main: 900 }))).toBe("fresh");
  });

  it("leaves an empty New thread for the thread the person wrote in last", () => {
    const older = thread("older", 50);
    expect(mainConversation("fresh", [fresh, main, older], evidence({ main: 200, older: 150 }))).toBe("main");
  });

  it("leaves a routine run thread even when it holds the routine's prompt", () => {
    const tagged = thread("tagged", 400, { routineRunId: "run-1" });
    expect(mainConversation("tagged", [tagged, main], evidence({ tagged: 401, main: 200 }))).toBe("main");
    const webhook = thread("webhook", 500);
    const runs = [{ threadId: "webhook", startedAt: 500 }];
    expect(mainConversation("webhook", [webhook, main], evidence({ webhook: 501, main: 200 }, runs))).toBe("main");
  });

  it("never picks an archived thread or a run thread as the conversation", () => {
    const archived = thread("archived", 50, { archivedAt: 60 });
    const run = thread("run", 700);
    const runs = [{ threadId: "run", startedAt: 700 }];
    expect(mainConversation("archived", [archived, fresh, run, main], evidence({ archived: 990, run: 980, main: 200 }, runs))).toBe("main");
  });

  it("falls back to the oldest open thread that is not a run when the person wrote nowhere, preferring the current one on a tie", () => {
    const run = thread("run", 10, { routineRunId: "run-1" });
    expect(mainConversation("fresh", [fresh, main, run], evidence())).toBe("main");
    const twin = thread("twin", 100);
    expect(mainConversation("twin", [main, twin], evidence())).toBe("twin");
  });

  it("leaves the pointer when no thread qualifies or it points outside the dog's threads", () => {
    const archived = thread("archived", 50, { archivedAt: 60 });
    const run = thread("run", 10, { routineRunId: "run-1" });
    expect(mainConversation("archived", [archived, run], evidence({ run: 20 }))).toBe("archived");
    expect(mainConversation("orphan", [main, fresh], evidence({ main: 200 }))).toBe("orphan");
    expect(mainConversation("orphan", [], evidence())).toBe("orphan");
  });
});

describe("threads routine runs made", () => {
  it("counts a thread created when its run started, not a conversation the run joined or posted results to", () => {
    const made = madeForRoutineRun([
      { threadId: "own", startedAt: 500 },
      { threadId: "joined", startedAt: 500, sourceThreadId: "joined" },
      { threadId: "results", startedAt: 500, resultsThreadId: "results" },
      { threadId: "existing", startedAt: 500 },
    ]);
    expect(made(thread("own", 500))).toBe(true);
    expect(made(thread("own", 501))).toBe(true);
    expect(made(thread("joined", 600))).toBe(false);
    expect(made(thread("results", 600))).toBe(false);
    expect(made(thread("existing", 100))).toBe(false);
    expect(made(thread("unrelated", 600))).toBe(false);
  });

  it("reads runs from routines.json and treats a missing or damaged file as no runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-routine-runs-"));
    try {
      const file = join(dir, "routines.json");
      expect(savedRoutineRuns(file)).toEqual([]);
      writeFileSync(file, "{ not json");
      expect(savedRoutineRuns(file)).toEqual([]);
      writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [
        { id: "a", threadId: "webhook", startedAt: 5, triggerSource: "webhook" },
        { id: "b", threadId: "joined", startedAt: 6, sourceThreadId: "joined", resultsThreadId: "results" },
        { id: "queued", status: "queued" },
        { id: "bad", threadId: 7, startedAt: 8 },
        null,
      ] }));
      expect(savedRoutineRuns(file)).toEqual([
        { threadId: "webhook", startedAt: 5 },
        { threadId: "joined", startedAt: 6, sourceThreadId: "joined", resultsThreadId: "results" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("first start of 0.3.42 on a 0.3.41 data folder", () => {
  const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
  const opus: ModelSelection = { instanceId: "claude", model: "claude-opus-5" };
  const marker = join(DATA_DIR, "conversation-pointers-settled");
  const open = () => new Store(() => sonnet);
  const task = (threadId: string, createdAt: number, extra: Partial<TaskRecord> = {}): TaskRecord => ({
    threadId, title: threadId, createdAt, updatedAt: createdAt, resumeCursors: { claude: `session-${threadId}` },
    approvalMode: "ask", autoApprove: false, alwaysAllow: [], unread: false, ...extra,
  });
  const dog = (id: string, threadId: string, tasks: TaskRecord[] | undefined, extra: Partial<BotRecord> = {}) => ({
    id, threadId, name: id, title: "", description: "", soul: "", notifications: true, color: "yellow", unread: false,
    modelSelection: sonnet, resumeCursors: { claude: `session-${threadId}` }, createdAt: 1, approvalMode: "ask", autoApprove: false,
    ...(tasks ? { tasks } : {}), ...extra,
  });
  const say = (threadId: string, at: number, role: Message["role"], extra: Partial<Message> = {}) =>
    mdb.appendMessage(threadId, { id: `${threadId}-${at}`, at, role, kind: "text", text: `${role} at ${at}`, ...extra });
  const write = (name: string, value: unknown) => writeFileSync(join(DATA_DIR, name), JSON.stringify(value));
  const saved = (name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), "utf8"));

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(() => mdb.closeMessageDb());

  it("opens a dog left on an empty New thread on the conversation it was having", () => {
    say("main", 150, "user");
    say("main", 160, "bot");
    say("main", 200, "user");
    write("bots.json", [dog("rex", "fresh", [task("fresh", 300, { title: "New thread" }), task("main", 100, { pinnedMessageId: "main-150" })])]);

    const store = open();
    expect(store.bot("rex")).toMatchObject({ threadId: "main", resumeCursors: { claude: "session-main" }, pinnedMessageId: "main-150" });
    expect(store.tasks("rex").map((entry) => entry.threadId)).toEqual(["fresh", "main"]);
    expect(saved("bots.json")[0].threadId).toBe("main");
    expect(existsSync(marker)).toBe(true);
  });

  it("opens a dog left on a webhook run on its conversation, and another dog's asks do not count as the person writing", () => {
    say("main", 200, "user");
    say("webhook", 501, "user");
    say("webhook", 502, "bot");
    say("work", 600, "user", { peerAsk: { botId: "ace", name: "Ace" } });
    write("routines.json", { version: 1, routines: [], runs: [
      { id: "run-1", routineId: "hook", routineName: "Deploys", botId: "rex", threadId: "webhook", triggerSource: "webhook", status: "completed", createdAt: 499, startedAt: 500 },
    ] });
    write("bots.json", [
      dog("rex", "webhook", [task("webhook", 500, { title: "Deploys · Oct 18, 9:00 AM" }), task("main", 100)]),
      dog("ace", "work", [task("work", 590), task("home", 50)]),
    ]);

    const store = open();
    expect(store.bot("rex")?.threadId).toBe("main");
    expect(store.bot("ace")?.threadId).toBe("home");
  });

  it("keeps a newer thread the person really used", () => {
    say("main", 900, "user");
    say("newer", 350, "user");
    write("bots.json", [dog("rex", "newer", [task("newer", 300), task("main", 100)])]);

    expect(open().bot("rex")?.threadId).toBe("newer");
    expect(saved("bots.json")[0].threadId).toBe("newer");
  });

  it("takes the dog's default model from the conversation it now opens on", () => {
    say("main", 200, "user");
    write("bots.json", [dog("rex", "fresh", [task("fresh", 300), task("main", 100, { modelSelection: opus })])]);

    const store = open();
    expect(store.bot("rex")).toMatchObject({ threadId: "main", modelSelection: opus });
    expect(store.taskByThread("rex", "main")?.modelSelection).toBeUndefined();
  });

  it("opens a group chat on the conversation people wrote in, not its empty new task", () => {
    say("room-main", 200, "user");
    say("room-main", 210, "bot", { from: { botId: "rex", name: "rex", color: "yellow" } });
    write("bots.json", [dog("rex", "main", [task("main", 100)])]);
    const room = {
      id: "room", threadId: "room-fresh", name: "Room", memberIds: ["rex"], defaultResponder: { kind: "member", botId: "rex" },
      bulletin: "", unread: false, createdAt: 1, busyBotId: null,
      tasks: [
        { threadId: "room-fresh", title: "New task", createdAt: 300, updatedAt: 300 },
        { threadId: "room-main", title: "Plans", createdAt: 100, updatedAt: 210, pinnedMessageId: "room-main-200" },
      ],
    } as unknown as GroupRecord;
    write("groups.json", [room]);

    const store = open();
    expect(store.group("room")).toMatchObject({ threadId: "room-main", pinnedMessageId: "room-main-200" });
    expect(saved("groups.json")[0].threadId).toBe("room-main");
  });

  it("leaves dogs with no threads, or no thread that qualifies, where they were", () => {
    say("lonely", 100, "user");
    write("bots.json", [
      dog("bare", "lonely", undefined),
      dog("archived", "gone", [task("gone", 300, { archivedAt: 400 }), task("older", 100, { archivedAt: 200 })]),
    ]);

    const store = open();
    expect(store.bot("bare")?.threadId).toBe("lonely");
    expect(store.tasks("bare").map((entry) => entry.threadId)).toEqual(["lonely"]);
    expect(store.bot("archived")?.threadId).toBe("gone");
    expect(existsSync(marker)).toBe(true);
  });

  it("runs once per data folder", () => {
    say("main", 200, "user");
    write("bots.json", [dog("rex", "fresh", [task("fresh", 300), task("main", 100)])]);
    writeFileSync(marker, "settled\n");

    expect(open().bot("rex")?.threadId).toBe("fresh");
    expect(saved("bots.json")[0].threadId).toBe("fresh");
  });

  it("waits for a dogs file it can read", () => {
    say("main", 200, "user");
    writeFileSync(join(DATA_DIR, "bots.json"), "{ not json");
    open();
    expect(existsSync(marker)).toBe(false);
    write("bots.json", [dog("rex", "fresh", [task("fresh", 300), task("main", 100)])]);
    expect(open().bot("rex")?.threadId).toBe("main");
  });
});
