import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RoomHandoffs, type RoomHandoff, type RoomHandoffHooks } from "../room-handoffs.ts";
import type { HandoffRunResult } from "./long-work.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { handoffWait, handoffWorkDone, olderWorkFields } from "./chat-work.ts";
import { TURNLESS_MS } from "./turnless-requests.ts";
import { waitingOn } from "./waiting-on.ts";
import { workState } from "./work-state.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-work-"));
afterAll(() => removeTempDir(dir));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const chief = { botId: "chief", threadId: "chief-chat" };
const scout = { botId: "scout", threadId: "scout-chat" };
const patch = { botId: "patch", threadId: "patch-chat" };
const NAMES: Record<string, string> = { chief: "Chief", scout: "Scout", patch: "Patch" };

function handoffs(name: string, busy: (botId: string) => boolean, run: RoomHandoffHooks["run"] = () => new Promise(() => {}), more: Partial<RoomHandoffHooks> = {}, now?: () => number) {
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: (node) => busy(node.botId), run, report: () => {}, changed: () => {}, ...more };
  return new RoomHandoffs(join(dir, `${name}.json`), hooks, now);
}

function tell(record: RoomHandoffs, to: { botId: string; threadId: string }, text: string, turn = "turn") {
  return record.enqueue(chief, turn, undefined, to, text, text, false, false, "", undefined, undefined, undefined, undefined, false, "none").node;
}

function chatAsTheWireSees(record: RoomHandoffs, threadId: string, busy: boolean) {
  const handoff = handoffWait(busy, record.coordinating(threadId), () => waitingOn(record.sentStillOpen(threadId), (botId) => NAMES[botId]));
  const work = workState({ busy, ...(handoff.waitingOn ? { waitingOn: handoff.waitingOn } : {}) });
  return { work, older: olderWorkFields(busy, busy ? "working" : "idle", handoff) };
}

function scoutFinishes() {
  let finish!: (result: HandoffRunResult) => void;
  const run = (node: RoomHandoff) => node.botId === "scout" ? new Promise<HandoffRunResult>((resolve) => { finish = resolve; }) : new Promise<HandoffRunResult>(() => {});
  return { run, finish: (text: string) => finish({ ok: true, text }) };
}

describe("a chat's handoffs, from the handoff record", () => {
  it("a dog that sent work with no reply wanted waits on the busy dog it is in line for, and that dog's own chat waits on no one", async () => {
    const record = handoffs("queued", (botId) => botId === "scout");
    tell(record, scout, "Ship it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(record.activeDirect(scout.threadId)).toBe(true);
    const sent = chatAsTheWireSees(record, chief.threadId, false);
    expect(sent.work).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] });
    expect(sent.older.waitingOn).toEqual([expect.objectContaining({ botId: "scout", state: "queued" })]);
    expect(chatAsTheWireSees(record, scout.threadId, false).work).toEqual({ kind: "idle" });
  });

  it("the dog that asked for a reply waits on its teammate by name", async () => {
    const record = handoffs("running", () => false);
    record.enqueue(chief, "turn", undefined, scout, "check", "Check the totals");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    const asked = chatAsTheWireSees(record, chief.threadId, false);
    expect(asked.work).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] });
    expect(asked.older).toMatchObject({ waitingForTeammates: true, waitingOn: [expect.objectContaining({ botId: "scout", name: "Scout" })] });
  });
});

describe("work a chat sent with no reply wanted", () => {
  it("keeps the chat waiting on that dog by name while the work runs, and clears when the work ends", async () => {
    const scoutRun = scoutFinishes();
    const record = handoffs("fyi-runs", () => false, scoutRun.run);
    const sent = tell(record, scout, "Ship it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(sent.status).toBe("running");
    const working = chatAsTheWireSees(record, chief.threadId, false);
    expect(working.work).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] });
    expect(working.older).toMatchObject({ waitingForTeammates: true, waitingOn: [expect.objectContaining({ botId: "scout", state: "running" })] });
    expect(chatAsTheWireSees(record, chief.threadId, true).work).toEqual({ kind: "running" });
    scoutRun.finish("Shipped.");
    await flush();
    record.tick(); await flush();
    expect(sent.status).toBe("completed");
    const done = chatAsTheWireSees(record, chief.threadId, false);
    expect(done.work).toEqual({ kind: "idle" });
    expect(done.older.waitingForTeammates).toBe(false);
  });

  it("tells the chat that sent the work when that work changes, not only the chat doing it", async () => {
    const scoutRun = scoutFinishes();
    const heard: string[][] = [];
    const record = handoffs("fyi-heard", () => false, scoutRun.run, {
      needsYou: (node) => node.botId === "scout" && node.result === "Which tag?",
      changed: (_groups, threads) => { heard.push([...threads]); },
    });
    const sent = tell(record, scout, "Ship it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    heard.length = 0;
    scoutRun.finish("Which tag?");
    await flush();
    expect(sent.status).toBe("needs-you");
    expect(heard.flat()).toContain(chief.threadId);
    expect(chatAsTheWireSees(record, chief.threadId, false).older.waitingOn).toEqual([expect.objectContaining({ botId: "scout", state: "needsYou" })]);
  });

  it("lets go of it when the person stops the chat, without ending it, names all of it, started or still in line, and keeps waiting when the home stops the chat", async () => {
    const record = handoffs("fyi-stop", (botId) => botId === "patch");
    const toScout = tell(record, scout, "Ship it");
    const toPatch = tell(record, patch, "Tag it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect([toScout.status, toPatch.status]).toEqual(["running", "queued"]);
    expect(record.stopAwaitingDirect(chief.threadId, "interrupted")).toEqual([]);
    expect(chatAsTheWireSees(record, chief.threadId, false).work).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }, { id: "patch", name: "Patch" }] });
    expect(record.stopAwaitingDirect(chief.threadId, "person").map((node) => node.botId)).toEqual(["scout", "patch"]);
    expect([toScout.status, toPatch.status]).toEqual(["running", "queued"]);
    const stopped = chatAsTheWireSees(record, chief.threadId, false);
    expect(stopped.work).toEqual({ kind: "idle" });
    expect(stopped.older.waitingForTeammates).toBe(false);
    expect(record.stopAwaitingDirect(chief.threadId, "person")).toEqual([]);
    const reopened = handoffs("fyi-stop", () => false, undefined, { longWork: () => true });
    expect([...reopened.nodes.values()].filter((node) => node.parentId).map((node) => node.status)).toEqual(["running", "queued"]);
    expect(chatAsTheWireSees(reopened, chief.threadId, false).work).toEqual({ kind: "idle" });
  });

  it("ends with a restart when it cannot carry on, and the chat stops waiting", async () => {
    const record = handoffs("fyi-restart", () => false);
    tell(record, scout, "Ship it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(chatAsTheWireSees(record, chief.threadId, false).work.kind).toBe("waiting-on-dog");
    const reopened = handoffs("fyi-restart", () => false, undefined, { longWork: () => false });
    reopened.tick(); await flush();
    expect([...reopened.nodes.values()].find((node) => node.botId === "scout")).toMatchObject({ status: "failed", endedBy: "restart" });
    expect(chatAsTheWireSees(reopened, chief.threadId, false).work).toEqual({ kind: "idle" });
  });

  it("is settled by the home once its dog has had no turn for ten minutes, and the chat stops waiting", async () => {
    let at = 1_000_000;
    let scoutTurn = true;
    const record = handoffs("fyi-turnless", () => false, undefined, { turnRunning: () => scoutTurn, lastWords: () => "Shipped." }, () => at);
    const sent = tell(record, scout, "Ship it");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    scoutTurn = false;
    record.tick(); await flush();
    expect(chatAsTheWireSees(record, chief.threadId, false).work.kind).toBe("waiting-on-dog");
    at += TURNLESS_MS;
    record.tick(); await flush();
    expect(sent).toMatchObject({ status: "completed", endedBy: "home" });
    expect(chatAsTheWireSees(record, chief.threadId, false).work).toEqual({ kind: "idle" });
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

  it("a chat waiting on a dog says it waits for teammates and names them, and keeps the activity it was given", () => {
    expect(olderWorkFields(false, "idle", waitingOnScout)).toEqual({ activity: "idle", waitingForTeammates: true, waitingOn: scoutWaiting });
    expect(olderWorkFields(false, "waiting-on-you", waitingOnScout)).toEqual({ activity: "waiting-on-you", waitingForTeammates: true, waitingOn: scoutWaiting });
  });

  it("counts only helpers as helpers working once the turn has ended, never a job on the dog's computer", () => {
    expect(olderWorkFields(false, "idle", noHandoff, 1)).toEqual({ activity: "idle", waitingForTeammates: false, helpersWorking: 1 });
    expect(olderWorkFields(false, "idle", noHandoff, 0)).toEqual({ activity: "idle", waitingForTeammates: false });
    expect(olderWorkFields(false, "idle", waitingOnScout, 1).helpersWorking).toBe(1);
    expect(olderWorkFields(true, "working", noHandoff, 1).helpersWorking).toBeUndefined();
  });

  it("says a handoff's work is done only when the chat's latest received handoff ended after the person last wrote", () => {
    const node = (over: Partial<RoomHandoff>): RoomHandoff => ({ id: "n", rootId: "r", parentId: "r", threadId: "scout-chat", botId: "scout", key: "k", text: "t", createdAt: 100, status: "completed", result: "", reported: true, executions: 1, approvalGranted: false, kind: "work", ...over });
    expect(handoffWorkDone("scout-chat", [node({})], 50)).toBe(true);
    expect(handoffWorkDone("scout-chat", [node({})], 150)).toBe(false);
    expect(handoffWorkDone("scout-chat", [node({ status: "running" })], 50)).toBe(false);
    expect(handoffWorkDone("scout-chat", [], 50)).toBe(false);
  });

});
