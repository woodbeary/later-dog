import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { handoffRunningIn, handoffWait, handoffWorkDone, olderWorkFields } from "./chat-work.ts";
import { waitingOn } from "./waiting-on.ts";
import { workState } from "./work-state.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-work-"));
afterAll(() => removeTempDir(dir));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const chief = { botId: "chief", threadId: "chief-chat" };
const scout = { botId: "scout", threadId: "scout-chat" };
const NAMES: Record<string, string> = { chief: "Chief", scout: "Scout" };

function handoffs(name: string, busy: (botId: string) => boolean, run: RoomHandoffHooks["run"] = () => new Promise(() => {})) {
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: (node) => busy(node.botId), run, report: () => {}, changed: () => {} };
  return new RoomHandoffs(join(dir, `${name}.json`), hooks);
}

function chatAsTheWireSees(record: RoomHandoffs, threadId: string, busy: boolean) {
  const handoff = handoffWait(busy, record.activeDirect(threadId), () => waitingOn(record.outstandingDirect(threadId), (botId) => NAMES[botId]));
  const work = workState({ busy, handoffRunning: handoffRunningIn(threadId, record.nodes.values()), ...(handoff.waitingOn ? { waitingOn: handoff.waitingOn } : {}) });
  return { work, older: olderWorkFields(work, busy, busy ? "working" : "idle", handoff) };
}

function scoutFinishes() {
  let finish!: (result: HandoffRunResult) => void;
  const run = (node: RoomHandoff) => node.botId === "scout" ? new Promise<HandoffRunResult>((resolve) => { finish = resolve; }) : new Promise<HandoffRunResult>(() => {});
  return { run, finish: (text: string) => finish({ ok: true, text }) };
}

describe("a chat's handoffs, from the handoff record", () => {
  it("a handoff waiting in line for a busy dog is not shown as waiting on anyone, in either chat", async () => {
    const record = handoffs("queued", (botId) => botId === "scout");
    record.enqueue(chief, "turn", undefined, scout, "fyi", "Ship it", false, false, "", undefined, undefined, undefined, undefined, false, "none");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(record.activeDirect(scout.threadId)).toBe(true);
    for (const threadId of [chief.threadId, scout.threadId]) {
      expect(handoffRunningIn(threadId, record.nodes.values())).toBe(false);
      expect(chatAsTheWireSees(record, threadId, false).work).toEqual({ kind: "idle" });
    }
  });

  it("the dog doing the handoff is running, and the one that asked for a reply waits on it by name", async () => {
    const record = handoffs("running", () => false);
    record.enqueue(chief, "turn", undefined, scout, "check", "Check the totals");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(handoffRunningIn(scout.threadId, record.nodes.values())).toBe(true);
    expect(handoffRunningIn(chief.threadId, record.nodes.values())).toBe(false);
    const asked = chatAsTheWireSees(record, chief.threadId, false);
    expect(asked.work).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] });
    expect(asked.older).toMatchObject({ waitingForTeammates: true, waitingOn: [expect.objectContaining({ botId: "scout", name: "Scout" })] });
  });
});

describe("the handoff keeps its own meaning of waiting for teammates", () => {
  it("a dog whose teammate has finished still waits until the result has been handed back to it", async () => {
    const scoutRun = scoutFinishes();
    let chiefBusyElsewhere = true;
    const record = handoffs("handed-back", (botId) => botId === "chief" && chiefBusyElsewhere, scoutRun.run);
    record.enqueue(chief, "turn", undefined, scout, "check", "Check the totals");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    scoutRun.finish("Totals match.");
    await flush();
    record.tick(); await flush();
    record.tick(); await flush();
    expect(record.outstandingDirect(chief.threadId)).toEqual([]);
    expect([...record.nodes.values()].find((node) => node.threadId === chief.threadId && !node.parentId)?.status).toBe("resume");

    const backNotHanded = chatAsTheWireSees(record, chief.threadId, false);
    expect(backNotHanded.older.waitingForTeammates).toBe(true);
    expect(backNotHanded.older.waitingOn).toEqual([]);
    expect(backNotHanded.work.kind).not.toBe("waiting-on-dog");

    chiefBusyElsewhere = false;
    record.tick(); await flush();
    expect(chatAsTheWireSees(record, chief.threadId, true).older.waitingForTeammates).toBe(false);
  });

  it("a dog the person stopped while its teammate still works is not waiting on that teammate", async () => {
    const record = handoffs("stopped", () => false);
    record.enqueue(chief, "turn", undefined, scout, "check", "Check the totals");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    const left = record.stopAwaitingDirect(chief.threadId, "person");
    expect(left.map((node) => node.botId)).toEqual(["scout"]);
    expect(record.outstandingDirect(chief.threadId).map((node) => node.botId)).toEqual(["scout"]);

    const stopped = chatAsTheWireSees(record, chief.threadId, false);
    expect(stopped.older.waitingForTeammates).toBe(false);
    expect(stopped.older).not.toHaveProperty("waitingOn");
    expect(stopped.work).toEqual({ kind: "idle" });
    expect(chatAsTheWireSees(record, scout.threadId, false).work.kind).toBe("running");
  });

  it("never says it waits for teammates while its own turn runs", () => {
    expect(handoffWait(true, true, () => { throw new Error("not read while busy"); })).toEqual({ waitingForTeammates: false });
    expect(handoffWait(false, false, () => { throw new Error("not read without a handoff"); })).toEqual({ waitingForTeammates: false });
  });
});

describe("the older fields", () => {
  const scoutWaiting = [{ botId: "scout", name: "Scout", state: "running" as const }];
  const waitingOnScout = { waitingForTeammates: true, waitingOn: scoutWaiting };
  const noHandoff = { waitingForTeammates: false };

  it("a chat waiting on a dog says it waits for teammates and names them, also when a question outranks it", () => {
    const waiting = workState({ busy: false, waitingOn: scoutWaiting });
    expect(olderWorkFields(waiting, false, "idle", waitingOnScout)).toEqual({ activity: "idle", waitingForTeammates: true, waitingOn: scoutWaiting });
    const asking = workState({ busy: false, waitingOn: scoutWaiting, needsYou: {} });
    expect(olderWorkFields(asking, false, "idle", waitingOnScout)).toEqual({ activity: "waiting-on-you", waitingForTeammates: true, waitingOn: scoutWaiting });
  });

  it("counts helpers and computer jobs as helpers working once the turn has ended, whatever outranks them", () => {
    const alive = { helpers: 1, computerJobs: 2 };
    expect(olderWorkFields(workState({ busy: false, ...alive }), false, "idle", noHandoff, alive)).toEqual({ activity: "idle", waitingForTeammates: false, helpersWorking: 3 });
    for (const facts of [{ needsYou: {} }, { usageHold: {} }, { waitingOn: scoutWaiting }]) {
      expect(olderWorkFields(workState({ busy: false, ...alive, ...facts }), false, "idle", noHandoff, alive).helpersWorking).toBe(3);
    }
    expect(olderWorkFields(workState({ busy: true }), true, "working", noHandoff, alive).helpersWorking).toBeUndefined();
  });

  it("says a handoff's work is done only when the chat's latest received handoff ended after the person last wrote", () => {
    const node = (over: Partial<RoomHandoff>): RoomHandoff => ({ id: "n", rootId: "r", parentId: "r", threadId: "scout-chat", botId: "scout", key: "k", text: "t", createdAt: 100, status: "completed", result: "", reported: true, executions: 1, approvalGranted: false, kind: "work", ...over });
    expect(handoffWorkDone("scout-chat", [node({})], 50)).toBe(true);
    expect(handoffWorkDone("scout-chat", [node({})], 150)).toBe(false);
    expect(handoffWorkDone("scout-chat", [node({ status: "running" })], 50)).toBe(false);
    expect(handoffWorkDone("scout-chat", [], 50)).toBe(false);
  });

  it("never says working when nothing runs", () => {
    expect(olderWorkFields(workState({ busy: false }), false, "working", noHandoff).activity).toBe("idle");
    expect(olderWorkFields(workState({ busy: true }), true, "working", noHandoff).activity).toBe("working");
  });
});
