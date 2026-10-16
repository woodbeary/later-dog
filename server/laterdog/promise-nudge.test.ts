import { describe, expect, it } from "vitest";

import type { WireMessage } from "../../shared/wire.ts";
import { PROMISE_NUDGE, createPromiseNudges, endsOnPromise, promiseReply, type PromiseNudgeHost } from "./promise-nudge.ts";

describe("a reply that only says what the dog will do next", () => {
  it.each([
    "I'm checking Cloudflare on your cloud computer.",
    "I’m checking Cloudflare on your cloud computer.",
    "I'll start on the migration now.",
    "Next I'll wire up the API.",
    "Next, I'll run the full suite.",
    "Continuing…",
    "Continuing.",
    "On it.",
    "On it — checking the deploy.",
    "Okay, I'm checking the logs now.",
    "Got it. Let me look into the failing test.",
    "Sure — I'll take a look.",
    "Now running the full suite.",
    "Checking the Worker routes.",
    "Let me pull the latest main and rebuild.",
    "I'm going to rerun the migration against staging.",
    "I am now investigating why the build broke.",
    "**On it** — running `pnpm test` again.",
    "Thanks for the heads up. I'll dig into it.",
    "Working on it.",
    "I'm working on the fix now and will report back.",
    "Let me go ahead and open a draft PR.",
  ])("nudges after %j", (text) => {
    expect(endsOnPromise(text)).toBe(true);
  });

  it.each([
    ["it asked the person something", "Should I deploy it to production?"],
    ["it asked, even after a promise", "I'll deploy it. Is that okay?"],
    ["it said it is done", "Done. I'll keep an eye on it."],
    ["it said it finished", "Finished the migration; next I'll update the docs."],
    ["it reported tests passing", "Tests pass. Next I'll update the docs."],
    ["it is blocked", "I'm blocked on the API key."],
    ["it cannot go on", "I can't reach Cloudflare from here."],
    ["it waits for the person", "I'll wait for your go-ahead."],
    ["it needs the person", "I'm going to need you to sign in first."],
    ["it hands the choice back", "Let me know if you want more."],
    ["it promises later", "I'll check back later."],
    ["it promises tomorrow", "I'll do the rest tomorrow."],
    ["it says it will remember", "I'll remember that."],
    ["it keeps a note in mind", "I'll keep that in mind for next time."],
    ["it stops here", "I'll stop here."],
    ["it offers to stay around", "I'll be here if you need anything."],
    ["it shows results", "Here's what I found: the route is missing."],
    ["it has a finding first", "The API returns 500s. I'll check the logs."],
    ["it lists steps", "Next I'll:\n- run the tests\n- open a PR"],
    ["it carries code", "I'll run this:\n```\npnpm test\n```"],
    ["it is a plain answer", "Your next meeting is at 3 pm."],
    ["it apologises", "I'm sorry, I couldn't find that file."],
    ["it is unsure", "I'm not sure what you mean."],
    ["it is pleased", "I'm happy to help."],
    ["it says nothing", ""],
    ["it is long", `I'm checking ${"the very long list of services ".repeat(12)}now.`],
    ["it has too many parts", "Okay. Sure. Got it. I'll check the logs."],
    ["it is a thing word", "Everything is in place."],
    ["it says nothing changed", "Nothing changed."],
  ])("leaves it alone when %s", (_why, text) => {
    expect(endsOnPromise(text)).toBe(false);
  });

  it("leaves a missing reply alone", () => {
    expect(endsOnPromise(undefined)).toBe(false);
    expect(endsOnPromise(null)).toBe(false);
  });
});

let nextId = 0;
const message = (fields: Partial<WireMessage> & Pick<WireMessage, "role" | "kind">): WireMessage =>
  ({ id: `m${++nextId}`, at: nextId, ...fields }) as WireMessage;
const ask = (text = "Is Cloudflare healthy?") => message({ role: "user", kind: "text", text });
const step = (name = "Bash", extra: Partial<NonNullable<WireMessage["tool"]>> = {}) =>
  message({ role: "bot", kind: "activity", turnId: "turn-1", tool: { name, ok: true, itemId: `item-${nextId}`, ...extra } });
const say = (text: string, turnId = "turn-1") => message({ role: "bot", kind: "text", text, turnId });

describe("the turn that ended on a promise", () => {
  it("finds the promise that closed the person's request", () => {
    const request = ask();
    const reply = say("I'm checking Cloudflare on your cloud computer.");
    expect(promiseReply([request, step(), reply], "turn-1", request.id)).toBe(reply);
  });

  it("still counts a promise followed by work and then silence", () => {
    const request = ask();
    const reply = say("Checking the Worker now.");
    expect(promiseReply([request, reply, step(), step("Read")], "turn-1", request.id)).toBe(reply);
  });

  it("ignores a reply from another turn", () => {
    const request = ask();
    expect(promiseReply([request, say("Checking the Worker now.", "turn-0")], "turn-1", request.id)).toBeNull();
  });

  it("ignores a turn with a newer message from the person", () => {
    const request = ask();
    expect(promiseReply([request, say("Checking the Worker now."), ask("never mind")], "turn-1", request.id)).toBeNull();
  });

  it("keeps a message the person steered into the turn", () => {
    const request = ask();
    const steered = message({ role: "user", kind: "text", text: "also the DNS", steered: true });
    const reply = say("Checking the DNS records now.");
    expect(promiseReply([request, steered, reply], "turn-1", request.id)).toBe(reply);
  });

  it.each([
    ["an open question card", () => message({ role: "bot", kind: "options", card: { title: "Which?", subtitle: "", options: ["a", "b"], requestType: "question", requestId: "r1" } })],
    ["a connect-app card", () => message({ role: "bot", kind: "connector", connector: { app: "github" } as unknown as WireMessage["connector"] })],
    ["a handoff to another dog", () => message({ role: "bot", kind: "activity", tool: { name: "Handing off", ok: true }, threadRef: { botId: "b2", threadId: "t2", title: "Fix" } })],
    ["a cloud task", () => message({ role: "bot", kind: "activity", tool: { name: "Cloud task", ok: true }, cloudTask: {} as WireMessage["cloudTask"] })],
    ["a delegated job", () => step("mcp__laterdog__delegate_cloud_job")],
    ["a scheduled wake-up", () => step("mcp__laterdog__schedule_wakeup")],
    ["a failed turn", () => message({ role: "bot", kind: "activity", tool: { name: "error: the engine stopped", ok: false } })],
  ])("leaves it alone when the turn has %s", (_why, extra) => {
    const request = ask();
    expect(promiseReply([request, extra(), say("I'll check back on it.")], "turn-1", request.id)).toBeNull();
    expect(promiseReply([request, extra(), say("Checking the Worker now.")], "turn-1", request.id)).toBeNull();
  });

  it("does not count a notice that only mentions waking", () => {
    const request = ask();
    const reply = say("Checking the Worker now.");
    const notice = message({ role: "bot", kind: "activity", tool: { name: "notice: My Cloud is waking up", ok: true } });
    expect(promiseReply([request, notice, reply], "turn-1", request.id)).toBe(reply);
  });

  it("does not count an answered card or a voice note reply", () => {
    const request = ask();
    const answered = message({ role: "bot", kind: "options", card: { title: "Allow?", subtitle: "", options: ["Allow"], requestType: "permission", requestId: "r1", answered: "Allow" } });
    expect(promiseReply([request, answered, say("Checking the Worker now.")], "turn-1", request.id)).not.toBeNull();
    const voice = message({ role: "bot", kind: "text", text: "Checking the Worker now.", turnId: "turn-1", attachments: [{ kind: "audio", path: "a.m4a", mime: "audio/mp4" }] });
    expect(promiseReply([request, voice], "turn-1", request.id)).toBeNull();
  });

  it("needs the request to be the person's own message", () => {
    const request = ask();
    expect(promiseReply([request, say("Checking the Worker now.")], "turn-1", "missing")).toBeNull();
    const bot = say("hello");
    expect(promiseReply([bot, say("Checking the Worker now.")], "turn-1", bot.id)).toBeNull();
  });
});

function harness(path: WireMessage[], overrides: Partial<PromiseNudgeHost> = {}) {
  const started: Array<{ botId: string; threadId: string; prompt: string; requestMessageId: string }> = [];
  const deferred: Array<() => void> = [];
  const logs: string[] = [];
  let request = path.find((entry) => entry.role === "user")?.id;
  const host: PromiseNudgeHost = {
    path: () => path,
    request: () => request,
    ownerAutoDog: () => "bot-1",
    free: () => true,
    start: async (botId, threadId, prompt, requestMessageId) => { started.push({ botId, threadId, prompt, requestMessageId }); },
    defer: (run) => { deferred.push(run); },
    log: (line) => logs.push(line),
    ...overrides,
  };
  const nudges = createPromiseNudges(host);
  const flush = () => { while (deferred.length) deferred.shift()!(); };
  return { nudges, started, flush, logs, setRequest: (id: string | undefined) => { request = id; } };
}

describe("carrying on once after a promise", () => {
  it("continues the turn once with a short system nudge on the same request", async () => {
    const request = ask();
    const { nudges, started, flush } = harness([request, say("I'm checking Cloudflare on your cloud computer.")]);
    nudges.settled("t1", "turn-1");
    flush();
    expect(started).toEqual([{ botId: "bot-1", threadId: "t1", prompt: PROMISE_NUDGE, requestMessageId: request.id }]);
    expect(PROMISE_NUDGE).toMatch(/none of it has happened yet/);
    expect(PROMISE_NUDGE.length).toBeLessThan(400);
  });

  it("nudges at most once per message from the person", () => {
    const request = ask();
    const path = [request, say("Checking the Worker now.")];
    const { nudges, started, flush } = harness(path);
    nudges.settled("t1", "turn-1");
    flush();
    path.push(say("Still checking the Worker.", "turn-2"));
    nudges.settled("t1", "turn-2");
    flush();
    expect(started).toHaveLength(1);
  });

  it("nudges again for the person's next message", () => {
    const first = ask();
    const path = [first, say("Checking the Worker now.")];
    const { nudges, started, flush, setRequest } = harness(path);
    nudges.settled("t1", "turn-1");
    flush();
    const second = ask("and the DNS?");
    path.push(second, say("Checking the DNS now.", "turn-3"));
    setRequest(second.id);
    nudges.settled("t1", "turn-3");
    flush();
    expect(started.map((entry) => entry.requestMessageId)).toEqual([first.id, second.id]);
  });

  it("never nudges a dog that is not the owner's auto dog", () => {
    const { nudges, started, flush } = harness([ask(), say("Checking the Worker now.")], { ownerAutoDog: () => null });
    nudges.settled("t1", "turn-1");
    flush();
    expect(started).toEqual([]);
  });

  it("never nudges when the dog asked, finished or is blocked", () => {
    for (const text of ["Should I deploy?", "Done — the Worker is deployed.", "I'm blocked on the API token."]) {
      const { nudges, started, flush } = harness([ask(), say(text)]);
      nudges.settled("t1", "turn-1");
      flush();
      expect(started).toEqual([]);
    }
  });

  it("steps aside when the person or the queue got there first", () => {
    const { nudges, started, flush, logs } = harness([ask(), say("Checking the Worker now.")], { free: () => false });
    nudges.settled("t1", "turn-1");
    flush();
    expect(started).toEqual([]);
    expect(logs.join("\n")).toMatch(/moved on/);
  });

  it("steps aside when the request was stopped or replaced before it could carry on", () => {
    const { nudges, started, flush, setRequest } = harness([ask(), say("Checking the Worker now.")]);
    nudges.settled("t1", "turn-1");
    setRequest(undefined);
    flush();
    expect(started).toEqual([]);
  });

  it("logs a start that fails instead of throwing", async () => {
    const { nudges, flush, logs } = harness([ask(), say("Checking the Worker now.")], {
      start: async () => { throw Object.assign(new Error("this thread is already working"), { code: "thread_busy" }); },
    });
    nudges.settled("t1", "turn-1");
    flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(logs.join("\n")).toMatch(/could not carry on: this thread is already working/);
  });
});
