import { describe, expect, it, vi } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { createStallWatch, judgeChat, owedWork, STALL_QUIET_MS, type ChatNow } from "./stall-watch.ts";

const T0 = Date.parse("2026-11-08T06:25:00Z");
let seq = 0;
const row = (at: number, fields: Partial<WireMessage>): WireMessage => ({ id: `m${++seq}`, role: "bot", kind: "text", at, ...fields } as WireMessage);
const ask = (at: number, text = "please ship the fix") => row(at, { role: "user", text });
const said = (at: number, text: string, turnId: string, ok = true) => row(at, { text, turnId, turnTerminal: true, turnSucceeded: ok });
const tool = (at: number, turnId: string) => row(at, { kind: "activity", turnId, tool: { name: "Bash", ok: true, itemId: `i${seq}` } });
const failure = (at: number, name: string) => row(at, { kind: "activity", tool: { name, ok: false } });
const teammate = (at: number, name: string) => row(at, { kind: "activity", comm: { groupId: "g", withBotId: "patch", withName: "Patch", withColor: "teal" }, tool: { name, ok: false } });

const chat = (path: WireMessage[], over: Partial<ChatNow> = {}): ChatNow => ({
  name: "Clover", path, busy: false, requestOpen: false, helpers: 0, usageWait: false, queued: false, stoppedByPerson: false,
  mayContinue: true, teammates: [], now: Math.max(...path.map((message) => message.at)) + STALL_QUIET_MS + 1, ...over,
});

describe("finding work a chat still owes", () => {
  it("a turn that ended on a promise and then hit an error", () => {
    const path = [ask(T0), said(T0 + 1, "On it: opening the billing page now.", "t1", false), failure(T0 + 2, "error: Cloud computers can't start right now. It isn't anything you did. Try again.")];
    expect(owedWork(path)?.cause).toBe("it hit a problem: Cloud computers can't start right now");
  });

  it("a turn that ran tools and never answered", () => {
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), tool(T0 + 2, "t1")])?.cause).toBe("its turn ended before it answered");
  });

  it("a teammate whose work ended without a reply after the dog's last turn", () => {
    const owed = owedWork([ask(T0), said(T0 + 1, "I've sent it to Patch.", "t1"), teammate(T0 + 2, "Patch couldn't finish")]);
    expect(owed).toMatchObject({ cause: "Patch couldn't finish before replying", teammate: true });
  });

  it("nothing, once the dog answered, or the person stopped it, or a teammate was stopped by the person", () => {
    expect(owedWork([ask(T0), said(T0 + 1, "Done: the fix is live.", "t1")])).toBeUndefined();
    expect(owedWork([row(T0, { role: "user", text: "go", requestCancelled: true }), tool(T0 + 1, "t1")])).toBeUndefined();
    expect(owedWork([ask(T0), said(T0 + 1, "Sent to Patch.", "t1"), teammate(T0 + 2, "Patch stopped")])).toBeUndefined();
    expect(owedWork([ask(T0), said(T0 + 1, "Sent to Patch.", "t1"), teammate(T0 + 2, "Patch couldn't finish"), said(T0 + 3, "Patch hit a snag, so I did it.", "t2")])).toBeUndefined();
  });

  it("nothing for work another dog asked for, which its handoff owns", () => {
    expect(owedWork([row(T0, { role: "user", text: "check this", peerAsk: { botId: "c", name: "Clover" } }), tool(T0 + 1, "t1")])).toBeUndefined();
  });
});

describe("errors that end a turn", () => {
  it("an engine that closed mid-turn leaves the work owed, with the reason", () => {
    const owed = owedWork([ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: The engine stopped unexpectedly.")]);
    expect(owed).toMatchObject({ cause: "it hit a problem: The engine stopped unexpectedly", retry: true });
  });

  it("an error after the dog's last full answer from a later turn still counts", () => {
    const owed = owedWork([ask(T0), said(T0 + 1, "Done.", "t1"), tool(T0 + 2, "t2"), failure(T0 + 3, "error: Cloud computers can't start right now.")]);
    expect(owed?.cause).toBe("it hit a problem: Cloud computers can't start right now");
  });

  it("a sign-in or safety stop is explained, never retried", () => {
    const signIn = [ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: unexpected status 401 Unauthorized: Missing bearer")];
    expect(owedWork(signIn)?.retry).toBe(false);
    expect(judgeChat(chat(signIn)).kind).toBe("explain");
    const safety = [ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: stopped by a safety classifier")];
    expect(judgeChat(chat(safety)).kind).toBe("explain");
  });

  it("lines that already explain, and usage limits, are left to what wrote them", () => {
    const explained = row(T0 + 2, { kind: "activity", tool: { name: "error: later.dog restarted again before Clover finished this.", ok: false, pickup: "restart" } });
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), explained])).toBeUndefined();
    const limit = row(T0 + 2, { kind: "activity", tool: { name: "error: You've hit your limit", ok: false, quota: { kind: "five_hour" } } });
    expect(owedWork([ask(T0), said(T0 + 1, "Working on it now.", "t1", false), limit])).toBeUndefined();
  });
});

describe("judging a quiet chat", () => {
  const stuck = () => [ask(T0), said(T0 + 1, "On it: deploying now.", "t1", false), failure(T0 + 2, "error: the engine closed")];

  it("leaves a chat alone while anything is in progress", () => {
    for (const over of [{ busy: true }, { requestOpen: true }, { helpers: 2 }, { usageWait: true }, { queued: true }, { stoppedByPerson: true },
      { teammates: [{ id: "p", name: "Patch", working: true, canRun: true }] }] as Partial<ChatNow>[]) {
      expect(judgeChat(chat(stuck(), over)).kind).toBe("fine");
    }
  });

  it("waits a few quiet minutes before acting, and ignores chats quiet for many hours", () => {
    const path = stuck();
    expect(judgeChat(chat(path, { now: T0 + 2 + STALL_QUIET_MS - 1 }))).toEqual({ kind: "fine", why: "recent" });
    expect(judgeChat(chat(path, { now: T0 + 7 * 60 * 60_000 }))).toEqual({ kind: "fine", why: "old" });
  });

  it("carries on with the cause in plain words", () => {
    const verdict = judgeChat(chat(stuck()));
    expect(verdict).toMatchObject({ kind: "continue", line: "Clover stopped partway (it hit a problem: the engine closed), so Clover is carrying on by itself." });
    if (verdict.kind === "continue") expect(verdict.prompt).toContain("please ship the fix");
  });

  it("carries on twice at most, then says so once and stays quiet", () => {
    const path = stuck();
    const notice = (at: number) => row(at, { kind: "activity", tool: { name: "recovery: carrying on", ok: true, pickup: "watch" } });
    expect(judgeChat(chat([...path, notice(T0 + 3)])).kind).toBe("continue");
    const twice = [...path, notice(T0 + 3), tool(T0 + 4, "t2"), notice(T0 + 5)];
    expect(judgeChat(chat(twice))).toMatchObject({ kind: "explain", line: "Clover stopped partway (it hit a problem: the engine closed) and has not picked it up again. Send a message to carry on." });
    const explained = [...twice, row(T0 + 6, { kind: "activity", tool: { name: "Clover stopped partway", ok: false, pickup: "watch" } })];
    expect(judgeChat(chat(explained)).kind).toBe("fine");
  });

  it("says what stopped instead of carrying on when the chat may not carry on by itself", () => {
    expect(judgeChat(chat(stuck(), { mayContinue: false })).kind).toBe("explain");
  });

  it("says the person is needed when an awaited teammate cannot run", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    expect(judgeChat(chat(path, { now: T0 + 5, teammates: [{ id: "p", name: "Patch", working: false, canRun: false }] })))
      .toEqual({ kind: "needs-you", what: "Patch can't run until it has a working account", dogs: ["Patch"] });
  });

  it("does not keep saying waiting when an awaited teammate is idle and has not started", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    expect(judgeChat(chat(path, { teammates: [{ id: "p", name: "Patch", working: false, canRun: true }] })))
      .toMatchObject({ kind: "continue", cause: "Patch has not picked up the work it was given" });
  });
});

describe("the stall watch on the home", () => {
  const host = (path: WireMessage[], over: Partial<ChatNow> = {}) => {
    const rows = [...path];
    const append = vi.fn((_threadId: string, message: Omit<WireMessage, "id" | "at">) => {
      const added = { ...message, id: `n${++seq}`, at: rows.at(-1)!.at + 1 } as WireMessage;
      rows.push(added);
      return added;
    });
    const start = vi.fn(async (_botId: string, _threadId: string, _prompt: string, _requestMessageId: string) => {});
    const changed = vi.fn();
    const watch = createStallWatch({
      chats: () => [{ botId: "clover", threadId: "main" }],
      look: () => chat(rows, { now: Math.max(...path.map((message) => message.at)) + STALL_QUIET_MS + 1, ...over }),
      append, start, changed, log: () => {},
    });
    return { watch, rows, append, start, changed };
  };
  const stuck = () => [ask(T0), tool(T0 + 1, "t1")];

  it("carries the work on once, with one plain line, and no app connected", async () => {
    const path = stuck();
    const { watch, append, start } = host(path);
    watch.sweep();
    await Promise.resolve();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![1].tool).toMatchObject({ ok: true, pickup: "watch" });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![3]).toBe(path[0]!.id);
  });

  it("records a stopped state with the reason when it may not carry on", () => {
    const { watch, append, start } = host(stuck(), { mayContinue: false });
    watch.sweep();
    expect(start).not.toHaveBeenCalled();
    expect(append.mock.calls[0]![1].tool).toMatchObject({ ok: false, pickup: "watch" });
    expect(watch.facts("main")).toEqual({ stopped: { cause: "infrastructure", detail: "stalled" } });
    watch.sweep();
    expect(append).toHaveBeenCalledOnce();
    expect(watch.facts("main").stopped).toBeDefined();
  });

  it("says plainly when carrying on could not start", async () => {
    const { watch, append, start } = host(stuck());
    start.mockRejectedValueOnce(new Error("Patch is busy with other work."));
    watch.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![1].tool?.name).toContain("it could not start again: Patch is busy with other work");
    expect(watch.facts("main").stopped).toBeDefined();
  });

  it("shows needs-you for a teammate that cannot run, and clears it once work moves", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    const teammates = [{ id: "p", name: "Patch", working: false, canRun: false }];
    let busy = false;
    const changed = vi.fn();
    const watch = createStallWatch({
      chats: () => [{ botId: "clover", threadId: "main" }],
      look: () => chat(path, { teammates, busy, now: T0 + 5 }),
      append: vi.fn(), start: vi.fn(), changed, log: () => {},
    });
    watch.sweep();
    expect(watch.facts("main").needsYou?.what).toBe("Patch can't run until it has a working account");
    busy = true;
    watch.sweep();
    expect(watch.facts("main")).toEqual({});
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
