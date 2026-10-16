import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WireMessage } from "../../shared/wire.ts";
import {
  PICKUP_MAX_AGE_MS,
  answeredSince,
  answersPerson,
  couldNotLine,
  createInflightTurns,
  fileInflightLedger,
  notOwnerLine,
  pickUpAfterRestart,
  pickingUpNotice,
  planPickup,
  restartPickupPrompt,
  restartedAgainLine,
  tooOldLine,
  type InflightTurn,
  type RestartPickupHost,
} from "./restart-pickup.ts";

const NOW = 10_000_000;
let nextId = 0;
const message = (fields: Partial<WireMessage> & Pick<WireMessage, "role" | "kind">): WireMessage =>
  ({ id: `m${++nextId}`, at: NOW - 60_000 + nextId, ...fields }) as WireMessage;
const ask = (text = "Fix the login bug and open a PR.") => message({ role: "user", kind: "text", text });
const step = (name = "Bash", ok?: boolean) => message({ role: "bot", kind: "activity", turnId: "turn-1", tool: { name, itemId: `item-${nextId}`, ...(ok === undefined ? {} : { ok }) } });
const say = (text: string, turnId = "turn-1") => message({ role: "bot", kind: "text", text, turnId, turnTerminal: true });
const midTurn = (text: string, turnId = "turn-1") => message({ role: "bot", kind: "text", text, turnId });

const plan = (path: WireMessage[], overrides: Partial<Parameters<typeof planPickup>[0]> = {}) =>
  planPickup({ path, name: "Scout", owner: true, queued: false, routine: () => false, now: NOW, ...overrides });

describe("what counts as a reply to the person", () => {
  it("counts words, failures, asks and handoffs, not steps or status lines", () => {
    expect(answersPerson(say("Fixed it."))).toBe(true);
    expect(answersPerson(say("  "))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "text", text: "", attachments: [{ kind: "audio", path: "a.m4a", mime: "audio/mp4" }] }))).toBe(true);
    expect(answersPerson(step())).toBe(false);
    expect(answersPerson(step("Bash", false))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "activity", tool: { name: "error: the engine stopped", ok: false } }))).toBe(true);
    expect(answersPerson(message({ role: "bot", kind: "activity", tool: { name: "notice: Still on it: running tests", ok: true, statusLine: "live" } }))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "activity", tool: { name: "recovery: Picking up where it stopped, on Max.", ok: true } }))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "activity", tool: { name: "Handing off", ok: true }, threadRef: { botId: "b", threadId: "t", title: "x" } }))).toBe(true);
    expect(answersPerson(message({ role: "bot", kind: "screen" }))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "routine.run" }))).toBe(true);
  });

  it("counts an open card as an ask, but not one the restart expired or the person answered", () => {
    const card = { title: "Allow?", subtitle: "", options: ["Allow"], requestType: "permission" as const, requestId: "r1" };
    expect(answersPerson(message({ role: "bot", kind: "options", card }))).toBe(true);
    expect(answersPerson(message({ role: "bot", kind: "options", card: { ...card, expired: true } }))).toBe(false);
    expect(answersPerson(message({ role: "bot", kind: "options", card: { ...card, answered: "Allow" } }))).toBe(false);
  });

  it("does not count a usage limit row while the account battery carries the work on", () => {
    const limit = message({ role: "bot", kind: "activity", tool: { name: "error: usage limit reached", ok: false, quota: { resetsAt: "2026-10-15T20:00:00Z" } } });
    expect(answersPerson(limit, false)).toBe(true);
    expect(answersPerson(limit, true)).toBe(false);
  });
});

describe("whether the person got their answer before the restart", () => {
  it("counts a turn's final words, not what the dog said on the way", () => {
    expect(answeredSince([midTurn("I'm checking the logs."), step()])).toBe(false);
    expect(answeredSince([midTurn("Found it: the session cookie expires at once."), step()])).toBe(false);
    expect(answeredSince([midTurn("Mapped 14 RPC methods so far. Terminal access on the Mac works."), step()])).toBe(false);
    expect(answeredSince([step(), say("Fixed it and opened PR #12.")])).toBe(true);
    expect(answeredSince([step(), say("I'm checking the logs.")])).toBe(true);
  });

  it("falls back to reading the words when a reply carries no turn", () => {
    const loose = (text: string) => message({ role: "bot", kind: "text", text });
    expect(answeredSince([loose("Fixed it and opened PR #12.")])).toBe(true);
    expect(answeredSince([loose("I'm checking the logs now.")])).toBe(false);
  });

  it("picks up long work that posted findings before the restart", () => {
    expect(plan([ask("Continue system 2 in full."), midTurn("Found the RPC table in the bundle."), step(), midTurn("Read 3 of 9 modules."), step()])).toMatchObject({ kind: "resume" });
  });

  it("only counts words from the turn that was running last", () => {
    const later = message({ role: "bot", kind: "activity", turnId: "turn-2", tool: { name: "Bash", itemId: "item-y" } });
    expect(answeredSince([midTurn("Found it: the cookie expires."), later])).toBe(false);
  });

  it("does not count the last turn's final words once a newer turn on the same message was running", () => {
    const continuation = message({ role: "bot", kind: "activity", turnId: "turn-2", tool: { name: "Bash", itemId: "item-x" } });
    expect(answeredSince([say("I'm checking Cloudflare now."), continuation])).toBe(false);
    const status = message({ role: "bot", kind: "activity", turnId: "turn-2", tool: { name: "notice: Still on it", ok: true, statusLine: "live" } });
    expect(answeredSince([say("Done."), status])).toBe(true);
  });

  it("counts a failure or an open question wherever it is", () => {
    expect(answeredSince([midTurn("Looking."), message({ role: "bot", kind: "activity", tool: { name: "error: the engine stopped", ok: false } })])).toBe(true);
  });
});

describe("planning what to do with a message left without a reply", () => {
  it("picks the person's message up again when the restart cut the turn off", () => {
    const source = ask();
    expect(plan([say("hi"), source, step(), step("Edit")])).toEqual({ kind: "resume", source });
  });

  it("picks the message up even when the dog said a line on the way", () => {
    const source = ask();
    expect(plan([source, midTurn("I'm checking the login flow."), step()])).toEqual({ kind: "resume", source });
  });

  it("picks up a message the turn never got to", () => {
    const source = ask();
    expect(plan([source])).toEqual({ kind: "resume", source });
  });

  it("picks up after a usage limit the battery was going to carry on from", () => {
    const source = ask();
    const limit = message({ role: "bot", kind: "activity", tool: { name: "error: usage limit reached", ok: false, quota: {} } });
    expect(plan([source, step(), limit], { carriesOnAfterLimit: true })).toEqual({ kind: "resume", source });
    expect(plan([source, step(), limit], { carriesOnAfterLimit: false })).toEqual({ kind: "none", why: "answered" });
  });

  it("leaves answered, stopped, queued and dog-to-dog messages alone", () => {
    expect(plan([ask(), say("Done, PR #12 is open.")])).toEqual({ kind: "none", why: "answered" });
    expect(plan([message({ role: "user", kind: "text", text: "stop", requestCancelled: true })])).toEqual({ kind: "none", why: "stopped" });
    expect(plan([ask()], { queued: true })).toEqual({ kind: "none", why: "queued" });
    expect(plan([ask()], { busy: true })).toEqual({ kind: "none", why: "busy" });
    expect(plan([message({ role: "user", kind: "text", text: "help?", peerAsk: { botId: "b2", name: "Max" } })])).toEqual({ kind: "none", why: "from-a-dog" });
    expect(plan([ask()], { routine: () => true })).toEqual({ kind: "none", why: "routine" });
    expect(plan([say("hello")])).toEqual({ kind: "none", why: "no-message" });
  });

  it("says in one line why not when a restart cut off the pickup too", () => {
    const source = ask();
    const notice = message({ role: "bot", kind: "activity", tool: { name: `recovery: ${pickingUpNotice("Scout")}`, ok: true, pickup: "restart" } });
    expect(plan([source, notice, step()])).toEqual({ kind: "explain", source, line: restartedAgainLine("Scout") });
  });

  it("says in one line why not when someone other than the owner sent it", () => {
    const source = ask();
    expect(plan([source], { owner: false })).toEqual({ kind: "explain", source, line: notOwnerLine("Scout") });
  });

  it("says in one line why not when later.dog was off for hours", () => {
    const source = ask();
    expect(plan([source, step()], { now: NOW + PICKUP_MAX_AGE_MS })).toEqual({ kind: "explain", source, line: tooOldLine("Scout") });
  });

  it("writes plain one-line reasons", () => {
    for (const line of [restartedAgainLine("Scout"), notOwnerLine("Scout"), tooOldLine("Scout"), couldNotLine("Scout", "the engine is signed out.")]) {
      expect(line).not.toMatch(/\n/);
      expect(line).toMatch(/Scout/);
      expect(line).toMatch(/Send (it|your message) again/);
    }
    expect(couldNotLine("Scout", "the engine is signed out.")).toBe("later.dog restarted before Scout replied and could not pick it up again: the engine is signed out. Send it again to retry.");
  });

  it("gives the dog the person's words and tells it to check before repeating anything", () => {
    const prompt = restartPickupPrompt("Fix the login bug.");
    expect(prompt).toMatch(/^\[later\.dog restarted/);
    expect(prompt).toMatch(/Check the current state before you repeat anything/);
    expect(prompt.endsWith("\n\nFix the login bug.")).toBe(true);
  });
});

describe("remembering which turns are running", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("records running turns, forgets finished ones and keeps them through a crash", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-inflight-"));
    const file = join(dir, "turns-running.json");
    let clock = 5;
    const turns = createInflightTurns(fileInflightLedger(file), { now: () => clock });
    turns.sync("bot-1", [{ threadId: "t1", busy: true, activity: "working" }, { threadId: "t2", activity: "idle" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ threadId: "t1", botId: "bot-1", since: 5 }]);
    clock = 9;
    turns.sync("bot-1", [{ threadId: "t1", busy: true, activity: "working" }, { threadId: "t2", activity: "parked.computer" }]);
    expect(turns.running()).toEqual([{ threadId: "t1", botId: "bot-1", since: 5 }, { threadId: "t2", botId: "bot-1", since: 9 }]);
    turns.sync("bot-1", [{ threadId: "t1", activity: "idle" }, { threadId: "t2", activity: "parked.computer" }]);
    expect(turns.running().map((turn) => turn.threadId)).toEqual(["t2"]);
    turns.sync("bot-2", [{ threadId: "t3", busy: true, activity: "waiting-on-you" }]);
    turns.forget("bot-1");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ threadId: "t3", botId: "bot-2", since: 9 }]);

    const afterCrash = createInflightTurns(fileInflightLedger(file));
    expect(afterCrash.takeLeftovers()).toEqual([{ threadId: "t3", botId: "bot-2", since: 9 }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("keeps the turns left running until they are taken, even while new ones start", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-inflight-"));
    const file = join(dir, "turns-running.json");
    writeFileSync(file, JSON.stringify([{ threadId: "old", botId: "bot-1", since: 1 }, { nonsense: true }]));
    const turns = createInflightTurns(fileInflightLedger(file), { now: () => 2 });
    turns.sync("bot-1", [{ threadId: "new", busy: true }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ threadId: "old", botId: "bot-1", since: 1 }, { threadId: "new", botId: "bot-1", since: 2 }]);
    expect(turns.takeLeftovers()).toEqual([{ threadId: "old", botId: "bot-1", since: 1 }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ threadId: "new", botId: "bot-1", since: 2 }]);
  });

  it("does not forget running turns while later.dog shuts down", () => {
    const written: InflightTurn[][] = [];
    let stopping = false;
    const turns = createInflightTurns({ read: () => [], write: (open) => { written.push(open); } }, { now: () => 1, stopping: () => stopping });
    turns.sync("bot-1", [{ threadId: "t1", busy: true }]);
    stopping = true;
    turns.sync("bot-1", [{ threadId: "t1", activity: "idle" }]);
    turns.forget("bot-1");
    expect(written.at(-1)).toEqual([{ threadId: "t1", botId: "bot-1", since: 1 }]);
  });

  it("starts empty from a missing or broken file", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-inflight-"));
    expect(fileInflightLedger(join(dir, "none.json")).read()).toEqual([]);
    writeFileSync(join(dir, "broken.json"), "{");
    expect(fileInflightLedger(join(dir, "broken.json")).read()).toEqual([]);
  });
});

function pickupHost(paths: Record<string, WireMessage[]>, overrides: Partial<RestartPickupHost> = {}) {
  const started: Array<{ botId: string; threadId: string; prompt: string; requestMessageId: string }> = [];
  const timers: Array<() => void> = [];
  const host: RestartPickupHost = {
    path: (threadId) => paths[threadId] ?? [],
    dog: (threadId) => paths[threadId] ? { botId: "bot-1", name: "Scout" } : null,
    owner: () => true,
    queued: () => false,
    busy: () => false,
    routine: () => false,
    carriesOnAfterLimit: () => false,
    append: (threadId, fields) => {
      const full = message(fields as WireMessage);
      paths[threadId]!.push(full);
      return full;
    },
    patch: (threadId, messageId, patch) => {
      const list = paths[threadId]!;
      const at = list.findIndex((entry) => entry.id === messageId);
      list[at] = { ...list[at]!, ...patch };
    },
    start: async (botId, threadId, prompt, requestMessageId) => { started.push({ botId, threadId, prompt, requestMessageId }); },
    blocked: (error) => (error as { code?: string }).code === "thread_limit",
    now: () => NOW,
    later: (run) => { timers.push(run); },
    log: () => {},
    ...overrides,
  };
  return { host, started, timers };
}

const turn = (threadId: string): InflightTurn => ({ threadId, botId: "bot-1", since: NOW - 120_000 });

describe("picking messages up after a restart", () => {
  it("starts the cut-off turn again on the same message and says so in one line", async () => {
    const source = ask();
    const paths = { t1: [source, step()] };
    const { host, started } = pickupHost(paths);
    expect(await pickUpAfterRestart(host, [turn("t1"), turn("t1")])).toEqual([{ threadId: "t1", kind: "resumed", sourceId: source.id }]);
    expect(started).toEqual([{ botId: "bot-1", threadId: "t1", prompt: restartPickupPrompt(source.text!), requestMessageId: source.id }]);
    expect(paths.t1.at(-1)).toMatchObject({ role: "bot", kind: "activity", tool: { name: `recovery: ${pickingUpNotice("Scout")}`, ok: true, pickup: "restart" } });
  });

  it("explains in one line instead of starting when it cannot", async () => {
    const source = ask();
    const paths = { t1: [source] };
    const { host, started } = pickupHost(paths, { owner: () => false });
    expect(await pickUpAfterRestart(host, [turn("t1")])).toEqual([{ threadId: "t1", kind: "explained", line: notOwnerLine("Scout") }]);
    expect(started).toEqual([]);
    expect(paths.t1.at(-1)).toMatchObject({ tool: { name: `error: ${notOwnerLine("Scout")}`, ok: false, pickup: "restart" } });
  });

  it("turns the notice into the reason when the engine refuses", async () => {
    const paths = { t1: [ask()] };
    const { host } = pickupHost(paths, { start: async () => { throw new Error("Claude is signed out"); } });
    const [outcome] = await pickUpAfterRestart(host, [turn("t1")]);
    expect(outcome).toEqual({ threadId: "t1", kind: "explained", line: couldNotLine("Scout", "Claude is signed out") });
    expect(paths.t1.filter((entry) => entry.tool?.pickup)).toHaveLength(1);
    expect(paths.t1.at(-1)).toMatchObject({ tool: { name: `error: ${couldNotLine("Scout", "Claude is signed out")}`, ok: false, pickup: "restart" } });
  });

  it("waits for a free slot when the dog is full, then starts", async () => {
    const source = ask();
    const paths = { t1: [source] };
    let full = true;
    const started: string[] = [];
    const { host, timers } = pickupHost(paths, {
      start: async (_botId, threadId) => {
        if (full) throw Object.assign(new Error("limit"), { code: "thread_limit" });
        started.push(threadId);
      },
    });
    expect(await pickUpAfterRestart(host, [turn("t1")])).toEqual([{ threadId: "t1", kind: "waiting", sourceId: source.id }]);
    full = false;
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["t1"]);
  });

  it("drops a waiting pickup when the person sent something new meanwhile", async () => {
    const paths = { t1: [ask()] };
    const starts: string[] = [];
    const { host, timers } = pickupHost(paths, {
      start: async () => { starts.push("x"); throw Object.assign(new Error("limit"), { code: "thread_limit" }); },
    });
    await pickUpAfterRestart(host, [turn("t1")]);
    paths.t1.push(ask("never mind, do the other thing"));
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(1);
  });

  it("gives up waiting with a one-line reason after the retry window", async () => {
    const paths = { t1: [ask()] };
    let clock = NOW;
    const { host, timers } = pickupHost(paths, {
      now: () => clock,
      retryForMs: 60_000,
      start: async () => { throw Object.assign(new Error("limit"), { code: "thread_limit" }); },
    });
    await pickUpAfterRestart(host, [turn("t1")]);
    clock += 61_000;
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(paths.t1.at(-1)).toMatchObject({ tool: { name: `error: ${couldNotLine("Scout", "Scout stayed busy with other work")}`, ok: false } });
  });

  it("leaves gone dogs and answered threads alone", async () => {
    const paths = { t1: [ask(), say("All done.")] };
    const { host, started } = pickupHost(paths);
    expect(await pickUpAfterRestart(host, [turn("t1"), turn("gone")])).toEqual([
      { threadId: "t1", kind: "none", why: "answered" },
      { threadId: "gone", kind: "none", why: "gone" },
    ]);
    expect(started).toEqual([]);
  });
});
