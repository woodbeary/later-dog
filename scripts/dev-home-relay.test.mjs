import { describe, expect, it } from "vitest";
import { MacRelayQueue } from "../server/laterdog/mac-relay.ts";
import { askLocalDog, createRelay, mirrorProfile, syncMirrors } from "./dev-home-relay.mjs";

function fakeHome(queue) {
  const mirrors = new Map();
  const calls = [];
  const home = async (method, path, body) => {
    calls.push([method, path]);
    let m = path.match(/^\/api\/mac-relay\/mirrors\/([\w-]+)$/);
    if (method === "PUT" && m) {
      const known = mirrors.get(m[1]);
      const botId = known ?? `home-${m[1]}`;
      mirrors.set(m[1], botId);
      return { botId, created: !known, profile: body };
    }
    m = path.match(/^\/api\/mac-relay\/bots\/([\w-]+)\/job$/);
    if (method === "GET" && m) return { job: queue.nextJob(m[1]) };
    m = path.match(/^\/api\/mac-relay\/jobs\/([\w-]+)\/(result|fail)$/);
    if (method === "POST" && m) return m[2] === "result" ? { ok: queue.completeJob(m[1], body.text) } : { ok: queue.failJob(m[1], body.message) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { home, calls };
}

function fakeLocal({ answer = (text) => `done: ${text}`, silent = false } = {}) {
  const bots = [
    { id: "rex", threadId: "rex-main", name: "Rex", title: "Fixer", description: "Fixes bugs", color: "#d97706", busy: false },
    { id: "ada", threadId: "ada-main", name: "Ada", busy: false },
  ];
  const threads = new Map([["rex-main", [{ id: "old", role: "bot", kind: "text", text: "an old answer" }]], ["ada-main", []]]);
  const posted = [];
  let next = 0;
  const local = async (method, path, body) => {
    if (method === "GET" && path === "/api/bots") return { bots: bots.map((bot) => ({ ...bot })) };
    let m = path.match(/^\/api\/threads\/([\w-]+)\/messages/);
    if (method === "GET" && m) return { messages: [...threads.get(m[1])] };
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (method === "POST" && m) {
      posted.push([m[1], body]);
      const bot = bots.find((candidate) => candidate.id === m[1]);
      const thread = threads.get(body.threadId);
      thread.push({ id: `u${++next}`, role: "user", kind: "text", text: body.text });
      bot.busy = true;
      setTimeout(() => {
        thread.push({ id: `b${next}a`, role: "bot", kind: "activity", text: "working" });
        if (!silent) thread.push({ id: `b${next}`, role: "bot", kind: "text", text: answer(body.text) });
        bot.busy = false;
      }, 15);
      return { ok: true };
    }
    throw new Error(`unexpected local ${method} ${path}`);
  };
  return { local, posted, threads };
}

const quick = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) };

describe("the dev home relay", () => {
  it("mirrors every local dog with only the profile fields the home accepts", async () => {
    const { home } = fakeHome(new MacRelayQueue());
    const { local } = fakeLocal();
    const mirrors = await syncMirrors({ home, local });
    expect([...mirrors]).toEqual([["home-rex", { id: "rex", threadId: "rex-main" }], ["home-ada", { id: "ada", threadId: "ada-main" }]]);
    expect(mirrorProfile({ id: "x", name: "  ", soul: "secret", busy: true, color: "x".repeat(40) })).toEqual({ name: "Mac dog" });
  });

  it("carries a phone message to the local dog's own thread and its new reply back", async () => {
    const queue = new MacRelayQueue();
    const { home } = fakeHome(queue);
    const { local, posted } = fakeLocal();
    const relay = createRelay({ home, local, localPoll: quick });
    await relay.sync();
    const reply = queue.requestTurn("home-rex", "home-thread-9", "fix the bug, please");
    expect(await relay.poll()).toBe(1);
    await relay.idle();
    await expect(reply).resolves.toBe("done: fix the bug, please");
    expect(posted).toEqual([["rex", { text: "fix the bug, please", threadId: "rex-main" }]]);
    expect(await relay.poll()).toBe(0);
  });

  it("relays two dogs at once without one waiting on the other", async () => {
    const queue = new MacRelayQueue();
    const { home } = fakeHome(queue);
    const { local } = fakeLocal();
    const relay = createRelay({ home, local, localPoll: quick });
    await relay.sync();
    const replies = [queue.requestTurn("home-rex", "t1", "one"), queue.requestTurn("home-ada", "t2", "two")];
    expect(await relay.poll()).toBe(2);
    await relay.idle();
    expect(await Promise.all(replies)).toEqual(["done: one", "done: two"]);
  });

  it("fails the home turn when the local dog never answers", async () => {
    const queue = new MacRelayQueue();
    const { home } = fakeHome(queue);
    const { local } = fakeLocal({ silent: true });
    const outcome = queue.requestTurn("home-rex", "t1", "hello").then(() => "answered", (error) => error.message);
    const relay = createRelay({ home, local, localPoll: { ...quick, deadline: Date.now() + 100 } });
    await relay.sync();
    await relay.poll();
    await relay.idle();
    expect(await outcome).toMatch(/did not answer/);
  });

  it("never mistakes an earlier answer for the new one", async () => {
    const { local } = fakeLocal({ silent: true });
    await expect(askLocalDog({ local, bot: { id: "rex", threadId: "rex-main" }, text: "hi", ...quick, deadline: Date.now() + 80 })).rejects.toThrow(/did not answer/);
  });
});
