import { describe, expect, it, vi } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { createStallWatch, handoffWorking, judgeChat, owedWork, STALL_LOOKBACK_MS, STALL_QUIET_MS, stallWatchMode, type ChatNow, type StallWatchMode } from "./stall-watch.ts";

const T0 = Date.parse("2026-11-08T06:25:00Z");
const MINUTE = 60_000;
let seq = 0;
const row = (at: number, fields: Partial<WireMessage>): WireMessage => ({ id: `m${++seq}`, role: "bot", kind: "text", at, ...fields } as WireMessage);
const ask = (at: number, text = "please ship the fix", extra: Partial<WireMessage> = {}) => row(at, { role: "user", text, ...extra });
const said = (at: number, text: string, turnId: string, ok = true) => row(at, { text, turnId, turnTerminal: true, turnSucceeded: ok });
const digest = (at: number, turnId: string, ok: boolean) => row(at, { kind: "digest", text: "[digest]", turnId, turnSucceeded: ok });
const tool = (at: number, turnId: string) => row(at, { kind: "activity", turnId, tool: { name: "Bash", ok: true, itemId: `i${seq}` } });
const failure = (at: number, name: string) => row(at, { kind: "activity", tool: { name, ok: false } });
const notice = (at: number, ok = true) => row(at, { kind: "activity", tool: { name: ok ? "recovery: carrying on" : "error: stopped", ok, pickup: "watch" } });
const teammate = (at: number, name: string) => row(at, { kind: "activity", comm: { groupId: "g", withBotId: "patch", withName: "Patch", withColor: "teal" }, tool: { name, ok: false } });

const chat = (path: WireMessage[], over: Partial<ChatNow> = {}): ChatNow => ({
  name: "Clover", path, busy: false, requestOpen: false, helpers: 0, usageWait: false, queued: false, stoppedByPerson: false,
  mayContinue: true, routine: () => false, teammates: [], now: Math.max(...path.map((message) => message.at)) + 10 * MINUTE, ...over,
});

describe("work is owed only with evidence that it was cut", () => {
  it("an error after the dog said what it would do", () => {
    const path = [ask(T0), said(T0 + 1, "On it: opening the billing page now.", "t1", false), failure(T0 + 2, "error: Cloud computers can't start right now. Try again."), digest(T0 + 3, "t1", false)];
    expect(owedWork(path)).toMatchObject({ cause: "Cloud computers can't start right now", retry: true });
  });

  it("an engine that closed mid-turn", () => {
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: claude exited 1 before result"), digest(T0 + 3, "t1", false)])?.retry).toBe(true);
  });

  it("a failed turn with no words and no error line", () => {
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), digest(T0 + 2, "t1", false)])?.cause).toBe("the turn failed without a reply");
  });

  it("a teammate whose work ended without a reply", () => {
    expect(owedWork([ask(T0), said(T0 + 1, "I've sent it to Patch.", "t1"), teammate(T0 + 2, "Patch couldn't finish")])).toMatchObject({ teammate: "Patch" });
  });

  it("not a dog that answered a thank-you with only a tapback", () => {
    const path = [said(T0, "The fix is live.", "t0"), ask(T0 + 1, "thanks", { reactions: [{ emoji: "👍", by: "dog-1" }] })];
    expect(owedWork(path)).toBeUndefined();
    expect(judgeChat(chat(path))).toEqual({ kind: "fine", why: "settled" });
    expect(owedWork([...path, digest(T0 + 2, "t1", true)])).toBeUndefined();
  });

  it("not an acknowledgement that got no reply at all", () => {
    expect(owedWork([said(T0, "Done.", "t0"), ask(T0 + 1, "thanks")])).toBeUndefined();
    expect(owedWork([said(T0, "Done.", "t0"), ask(T0 + 1, "👍")])).toBeUndefined();
  });

  it("not a normal turn that ended without words", () => {
    expect(owedWork([ask(T0, "tidy the folder"), tool(T0 + 1, "t1"), digest(T0 + 2, "t1", true)])).toBeUndefined();
  });

  it("not a chat whose last thing is a card the person dismissed", () => {
    expect(owedWork([ask(T0), row(T0 + 1, { kind: "options", card: { title: "Allow?", subtitle: "", options: ["Allow"], dismissed: true } })])).toBeUndefined();
  });

  it("not answered, stopped, handed-over or later-recovered work", () => {
    expect(owedWork([ask(T0), said(T0 + 1, "Done: the fix is live.", "t1")])).toBeUndefined();
    expect(owedWork([ask(T0, "go", { requestCancelled: true }), tool(T0 + 1, "t1"), failure(T0 + 2, "error: closed")])).toBeUndefined();
    expect(owedWork([ask(T0), said(T0 + 1, "Sent to Patch.", "t1"), teammate(T0 + 2, "Patch stopped")])).toBeUndefined();
    expect(owedWork([ask(T0), said(T0 + 1, "Sent.", "t1"), teammate(T0 + 2, "Patch couldn't finish"), said(T0 + 3, "I did it myself.", "t2")])).toBeUndefined();
    expect(owedWork([ask(T0, "check this", { peerAsk: { botId: "c", name: "Clover" } }), tool(T0 + 1, "t1"), failure(T0 + 2, "error: closed")])).toBeUndefined();
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: closed"), tool(T0 + 3, "t2"), digest(T0 + 4, "t2", true)])).toBeUndefined();
  });

  it("leaves usage limits and lines that already explain to what wrote them", () => {
    const limit = row(T0 + 2, { kind: "activity", tool: { name: "error: You've hit your limit", ok: false, quota: { kind: "five_hour" } } });
    expect(owedWork([ask(T0), said(T0 + 1, "Working on it now.", "t1", false), limit])).toBeUndefined();
    const explained = row(T0 + 2, { kind: "activity", tool: { name: "error: later.dog restarted again.", ok: false, pickup: "restart" } });
    expect(owedWork([ask(T0), tool(T0 + 1, "t1"), explained])).toBeUndefined();
  });
});

describe("what the person reads", () => {
  const cut = () => [ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: claude exited 1 before result"), digest(T0 + 3, "t1", false)];

  it("carrying on, in plain words with no error text", () => {
    const verdict = judgeChat(chat(cut()));
    expect(verdict).toMatchObject({ kind: "continue", line: "Clover stopped before finishing, so it is carrying on by itself." });
    if (verdict.kind === "continue") expect(verdict.prompt).toContain("please ship the fix");
  });

  it("a teammate that stopped", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1"), teammate(T0 + 2, "Patch was interrupted")];
    expect(judgeChat(chat(path))).toMatchObject({ kind: "continue", line: "Patch stopped before replying, so Clover is picking the work back up." });
  });

  it("not carried on", () => {
    expect(judgeChat(chat(cut(), { mayContinue: false }))).toMatchObject({ kind: "explain", line: "Clover stopped before finishing and has not picked it up again. Send a message to carry on." });
  });

  it("a sign-in, permission or safety stop says what is needed and is never retried", () => {
    const stop = (name: string) => judgeChat(chat([ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, name)]));
    expect(stop("error: unexpected status 401 Unauthorized")).toMatchObject({ kind: "explain", line: "Clover stopped because its account needs you to sign in again." });
    expect(stop("error: permission denied for this action")).toMatchObject({ kind: "explain", line: "Clover stopped because it needs your permission to go on." });
    expect(stop("error: stopped by a safety classifier")).toMatchObject({ kind: "explain", line: "Clover stopped before finishing and has not picked it up again. Send a message to carry on." });
  });
});

describe("judging a quiet chat", () => {
  const cut = () => [ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: the engine closed")];

  it("leaves a chat alone while anything is in progress", () => {
    for (const over of [{ busy: true }, { requestOpen: true }, { helpers: 2 }, { usageWait: true }, { queued: true }, { stoppedByPerson: true },
      { teammates: [{ id: "p", name: "Patch", working: true, canRun: true }] }] as Partial<ChatNow>[]) {
      expect(judgeChat(chat(cut(), over)).kind).toBe("fine");
    }
  });

  it("acts after three quiet minutes and only within thirty", () => {
    expect(STALL_LOOKBACK_MS).toBe(30 * MINUTE);
    expect(judgeChat(chat(cut(), { now: T0 + 2 + STALL_QUIET_MS - 1 }))).toEqual({ kind: "fine", why: "recent" });
    expect(judgeChat(chat(cut(), { now: T0 + 2 + 29 * MINUTE })).kind).toBe("continue");
    expect(judgeChat(chat(cut(), { now: T0 + 2 + 31 * MINUTE }))).toEqual({ kind: "fine", why: "old" });
  });

  it("carries on twice at most, and a second failed carry-on does not bring a third", () => {
    const once = [...cut(), notice(T0 + 3), tool(T0 + 4, "t2"), failure(T0 + 5, "error: the engine closed")];
    expect(judgeChat(chat(once)).kind).toBe("continue");
    const twice = [...once, notice(T0 + 6), tool(T0 + 7, "t3"), failure(T0 + 8, "error: the engine closed")];
    expect(judgeChat(chat(twice)).kind).toBe("explain");
    expect(judgeChat(chat([...twice, notice(T0 + 9, false)]))).toEqual({ kind: "fine", why: "explained" });
  });

  it("says the person is needed when an awaited teammate cannot run", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    expect(judgeChat(chat(path, { now: T0 + 5, teammates: [{ id: "p", name: "Patch", working: false, canRun: false }] })))
      .toEqual({ kind: "needs-you", what: "Patch can't run until it has a working account", dogs: ["Patch"] });
  });

  it("a teammate that handed part on to a third dog is still working, so nothing is picked back up", () => {
    const path = [ask(T0, "Have Patch build the report"), said(T0 + 1, "Patch is on it.", "t1"), digest(T0 + 2, "t1", true)];
    const patch = { id: "patch", name: "Patch", working: handoffWorking("waiting", true, false), canRun: true };
    expect(patch.working).toBe(true);
    expect(judgeChat(chat(path, { teammates: [patch] }))).toEqual({ kind: "fine", why: "teammates" });
  });

  it("a queued handoff is working when its dog can run, and needs the person when it cannot", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    expect(handoffWorking("queued", true, false)).toBe(true);
    expect(judgeChat(chat(path, { teammates: [{ id: "p", name: "Patch", working: handoffWorking("queued", true, false), canRun: true }] }))).toEqual({ kind: "fine", why: "teammates" });
    expect(handoffWorking("queued", false, false)).toBe(false);
    expect(judgeChat(chat(path, { teammates: [{ id: "p", name: "Patch", working: handoffWorking("queued", false, false), canRun: false }] })).kind).toBe("needs-you");
  });

  it("an outstanding handoff is never treated as stopped, even with no sign of work", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    expect(handoffWorking("needs-you", true, false)).toBe(false);
    expect(handoffWorking("running", true, false)).toBe(true);
    expect(handoffWorking("resume", true, false)).toBe(true);
    expect(judgeChat(chat(path, { teammates: [{ id: "p", name: "Patch", working: false, canRun: true }] }))).toEqual({ kind: "fine", why: "teammates" });
  });

  it("a routine's failed turn is left to the routine, judged at the time of the owed message", () => {
    const path = cut();
    const routine = vi.fn((at: number) => at === path[0]!.at);
    expect(judgeChat(chat(path, { routine }))).toEqual({ kind: "fine", why: "routine" });
    expect(routine).toHaveBeenCalledWith(path[0]!.at);
  });

  it("a chat the restart pickup already explained is settled, even with the cut turn's error line", () => {
    const giveUp = row(T0 + 3, { kind: "activity", tool: { name: "error: later.dog restarted again before Clover finished this. Send it again to try once more.", ok: false, pickup: "restart" } });
    expect(owedWork([...cut(), giveUp])).toBeUndefined();
    expect(judgeChat(chat([...cut(), giveUp]))).toEqual({ kind: "fine", why: "settled" });
  });
});

describe("the stall watch on the home", () => {
  const host = (path: WireMessage[], over: Partial<ChatNow> = {}, mode?: StallWatchMode) => {
    const rows = [...path];
    const now = Math.max(...path.map((message) => message.at)) + 10 * MINUTE;
    const append = vi.fn((_threadId: string, message: Omit<WireMessage, "id" | "at">) => {
      const added = { ...message, id: `n${++seq}`, at: rows.at(-1)!.at + 1 } as WireMessage;
      rows.push(added);
      return added;
    });
    const start = vi.fn(async (_botId: string, _threadId: string, _prompt: string, _requestMessageId: string) => {});
    const lines: string[] = [];
    const watch = createStallWatch({
      chats: () => [{ botId: "clover", threadId: "main" }],
      look: () => chat(rows, { now, ...over }),
      append, start, log: (line) => lines.push(line),
    }, { mode });
    return { watch, rows, append, start, lines };
  };
  const cut = () => [ask(T0), tool(T0 + 1, "t1"), failure(T0 + 2, "error: the engine closed")];

  it("carries the work on once, with one plain line, tied to the person's message", async () => {
    const path = cut();
    const { watch, append, start, lines } = host(path);
    watch.sweep();
    await Promise.resolve();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![1].tool).toEqual({ name: "recovery: Clover stopped before finishing, so it is carrying on by itself.", ok: true, pickup: "watch" });
    expect(start.mock.calls[0]![3]).toBe(path[0]!.id);
    expect(lines[0]).toContain("the engine closed");
  });

  it("an explained chat stays quiet across further sweeps and keeps showing stopped", () => {
    const { watch, append, start } = host(cut(), { mayContinue: false });
    watch.sweep();
    watch.sweep();
    watch.sweep();
    expect(start).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![1].tool).toMatchObject({ ok: false, pickup: "watch" });
    expect(watch.facts("main")).toEqual({ stopped: { cause: "infrastructure", detail: "stalled" } });
  });

  it("says plainly, without the error, when carrying on could not start", async () => {
    const { watch, append, start, lines } = host(cut());
    start.mockRejectedValueOnce(new Error("Patch is busy with other work."));
    watch.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![1].tool?.name).toBe("error: Clover stopped before finishing and has not picked it up again. Send a message to carry on.");
    expect(lines.some((line) => line.includes("Patch is busy"))).toBe(true);
  });

  it("in observe mode only logs, once per verdict, and writes or starts nothing", () => {
    const { watch, append, start, lines } = host(cut(), {}, "observe");
    watch.sweep();
    watch.sweep();
    expect(append).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(watch.facts("main")).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^stall watch \(observe\): main would carry on \(.+: the engine closed\)$/);
  });

  it("does not sweep until the restart pickup has finished its pass", async () => {
    vi.useFakeTimers();
    try {
      let finish = () => {};
      const ready = new Promise<void>((resolve) => { finish = resolve; });
      const look = vi.fn(() => null);
      const watch = createStallWatch({ chats: () => [{ botId: "clover", threadId: "main" }], look, append: vi.fn(), start: vi.fn(), log: () => {} },
        { everyMs: 1_000, ready });
      watch.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(look).not.toHaveBeenCalled();
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(look).toHaveBeenCalled();
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads its mode from one setting", () => {
    expect(stallWatchMode("observe")).toBe("observe");
    expect(stallWatchMode(" OFF ")).toBe("off");
    expect(stallWatchMode(undefined)).toBe("act");
    expect(stallWatchMode("yes")).toBe("act");
  });

  it("shows needs-you for a teammate that cannot run, and clears it once work moves", () => {
    const path = [ask(T0), said(T0 + 1, "Sent to Patch.", "t1")];
    let busy = false;
    const changed = vi.fn();
    const watch = createStallWatch({
      chats: () => [{ botId: "clover", threadId: "main" }],
      look: () => chat(path, { teammates: [{ id: "p", name: "Patch", working: false, canRun: false }], busy, now: T0 + 5 }),
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
