import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { dogInbox } from "../../deploy/laterdog/home/src/dog-inbox.ts";
import type { InboxRequest, StoredLetter } from "../../shared/dog-object-protocol.ts";
import { ObjectInbox, REDELIVER_WITHIN_MS } from "./object-inbox.ts";

const START = Date.parse("2026-11-27T20:00:00Z");

function sql(database: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

function world() {
  const clock = { now: START };
  const objects = new Map<string, ReturnType<typeof dogInbox>>();
  const objectFor = (dog: string) => objects.get(dog) ?? objects.set(dog, dogInbox(sql(new DatabaseSync(":memory:")), () => clock.now)).get(dog)!;
  const link = { failures: 0 };
  const calls = {
    async inbox(caller: string, _chat: string, body: InboxRequest & { dog?: string }): Promise<Record<string, unknown>> {
      if (link.failures > 0) {
        link.failures -= 1;
        throw new Error("coordinator unreachable");
      }
      if (body.op === "put") return { ok: true, letter: await objectFor(body.dog!).inboxPut(body.letter) };
      if (body.op === "pull") return { ok: true, letters: await objectFor(caller).inboxPull(body.after ?? 0, body.limit ?? 50) };
      if (body.op === "ack") return { ok: true, acked: await objectFor(caller).inboxAck(body.clientIds) };
      return { ok: true, states: await objectFor(body.dog!).inboxStatus(body.clientIds) };
    },
  };
  const nodes = new Map<string, string>();
  const redelivered: Array<{ dog: string; clientId: string }> = [];
  const book = {
    handoffStatus: (id: string) => nodes.get(id) ?? null,
    redeliver: async (dog: string, letter: StoredLetter) => { redelivered.push({ dog, clientId: letter.clientId }); },
  };
  const home = () => new ObjectInbox({ calls, owned: (dog) => dog === "dog-b", dogs: () => ["dog-a", "dog-b"], book: () => book, now: () => clock.now, wait: async () => {}, log: () => {} });
  const letter = (clientId: string) => ({ clientId, from: "dog-a", fromChat: "chat-a", toChat: "chat-b", text: `work ${clientId}`, replyTo: null });
  const states = (ids: string[]) => objectFor("dog-b").inboxStatus(ids);
  return { clock, link, nodes, redelivered, home, letter, states };
}

describe("dog-to-dog letters through the dog inbox", () => {
  it("records a letter as accepted and marks it delivered once the handoff starts", async () => {
    const w = world();
    const inbox = w.home();
    w.nodes.set("n1", "queued");
    await inbox.sent("dog-b", w.letter("n1"));
    expect(await w.states(["n1"])).toEqual({ n1: "accepted" });
    w.nodes.set("n1", "running");
    inbox.changed();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await w.states(["n1"])).toEqual({ n1: "delivered" });
    expect(inbox.pending()).toBe(0);
  });

  it("leaves dogs on the home's own delivery alone", async () => {
    const w = world();
    await w.home().sent("dog-a", { ...w.letter("n1"), from: "dog-b" });
    expect(await w.states(["n1"])).toEqual({});
  });

  it("stores a letter once even when the coordinator fails and the put is retried", async () => {
    const w = world();
    w.nodes.set("n1", "queued");
    w.link.failures = 2;
    await w.home().sent("dog-b", w.letter("n1"));
    expect(await w.states(["n1"])).toEqual({ n1: "accepted" });
  });

  it("delivers a letter whose handoff a restart lost exactly once, and only recent ones", async () => {
    const w = world();
    const before = w.home();
    w.nodes.set("lost", "queued");
    w.nodes.set("old", "queued");
    await before.sent("dog-b", w.letter("old"));
    w.clock.now = START + REDELIVER_WITHIN_MS + 60_000;
    await before.sent("dog-b", w.letter("lost"));
    w.nodes.clear();
    w.clock.now += 30_000;
    const after = w.home();
    await after.sweep();
    await after.sweep();
    expect(w.redelivered).toEqual([{ dog: "dog-b", clientId: "lost" }]);
    expect(await w.states(["lost", "old"])).toEqual({ lost: "delivered", old: "delivered" });
  });

  it("after a restart waits for a handoff that is still queued and acknowledges it when it starts", async () => {
    const w = world();
    w.nodes.set("n1", "queued");
    await w.home().sent("dog-b", w.letter("n1"));
    w.clock.now += 30_000;
    const after = w.home();
    await after.sweep();
    expect(await w.states(["n1"])).toEqual({ n1: "accepted" });
    w.nodes.set("n1", "completed");
    after.changed();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await w.states(["n1"])).toEqual({ n1: "delivered" });
    expect(w.redelivered).toEqual([]);
  });
});
