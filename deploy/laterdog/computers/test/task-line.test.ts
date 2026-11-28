import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { OWNER_KEY, type World, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function take(w: World, input: Record<string, unknown>) {
  const response = await w.fetch(apiRequest("POST", "/v1/task-line/tickets", OWNER_KEY, { body: input }));
  return { status: response.status, replayed: response.headers.get("idempotent-replayed"), ticket: (await body(response)).ticket };
}

async function poll(w: World, id: string, wait = 0) {
  return (await body(await w.fetch(apiRequest("GET", `/v1/task-line/tickets/${id}${wait ? `?wait=${wait}` : ""}`, OWNER_KEY)))).ticket;
}

async function cap(w: World, value: number) {
  return w.fetch(apiRequest("PUT", "/v1/task-line/settings", OWNER_KEY, { body: { cap: value } }));
}

async function five(w: World) {
  const tickets = [];
  for (let i = 1; i <= 5; i++) tickets.push((await take(w, { key: `home:t${i}:d1`, thread: `t${i}`, dog: "scout", size: "small", class: "task" })).ticket);
  return tickets;
}

describe("the task line", () => {
  it("admits three of five at cap 3, shows the other two their places, and admits both when the cap rises", async () => {
    const w = await world();
    expect((await cap(w, 3)).status).toBe(200);
    const tickets = await five(w);
    expect(tickets.map((t) => t.state)).toEqual(["admitted", "admitted", "admitted", "queued", "queued"]);
    expect(tickets.slice(3).map((t) => [t.place, t.ahead])).toEqual([[1, 0], [2, 1]]);
    expect(tickets[0].machine).toMatchObject({ size: "small", computerSize: "small", reused: false });
    expect(tickets[0].machine.id).toMatch(/^cmp_[a-z2-7]{12}$/);

    const waiting = [poll(w, tickets[3].id, 20), poll(w, tickets[4].id, 20)];
    expect((await cap(w, 5)).status).toBe(200);
    const after = await Promise.all(waiting);
    expect(after.map((t) => t.state)).toEqual(["admitted", "admitted"]);

    const line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.settings.cap).toBe(5);
    expect(line.running).toHaveLength(5);
    expect(line.waiting).toHaveLength(0);
  });

  it("answers a repeated ticket key with the same ticket", async () => {
    const w = await world();
    const first = await take(w, { key: "home:t1:d1", thread: "t1" });
    const again = await take(w, { key: "home:t1:d1", thread: "t1" });
    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 200, replayed: "true" });
    expect(again.ticket.id).toBe(first.ticket.id);
    expect(again.ticket.machine.id).toBe(first.ticket.machine.id);
  });

  it("gives a thread its live machine back for its next turn without a new slot", async () => {
    const w = await world();
    await cap(w, 1);
    const first = (await take(w, { key: "home:t1:d1", thread: "t1" })).ticket;
    await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${first.id}`, OWNER_KEY));
    const next = (await take(w, { key: "home:t1:d2", thread: "t1", class: "person" })).ticket;
    expect(next).toMatchObject({ state: "admitted", machine: { id: first.machine.id, reused: true } });
    const line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toMatchObject([{ id: first.machine.id, busy: true }]);
  });

  it("cancels a waiting ticket and moves the one behind it up", async () => {
    const w = await world();
    await cap(w, 1);
    await take(w, { key: "a", thread: "ta" });
    const b = (await take(w, { key: "b", thread: "tb" })).ticket;
    const c = (await take(w, { key: "c", thread: "tc" })).ticket;
    expect(c.place).toBe(2);
    const waiting = poll(w, c.id, 20);
    const cancelled = (await body(await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${b.id}`, OWNER_KEY)))).ticket;
    expect(cancelled.state).toBe("cancelled");
    expect(await waiting).toMatchObject({ state: "queued", place: 1, ahead: 0 });
  });

  it("releases a finished turn's machine, keeps it for the idle minutes, then stops it", async () => {
    const w = await world();
    const a = (await take(w, { key: "a", thread: "ta" })).ticket;
    await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${a.id}`, OWNER_KEY));
    let line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toMatchObject([{ id: a.machine.id, busy: false }]);
    await w.advance(4 * MINUTE);
    line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toHaveLength(1);
    await w.advance(MINUTE + 30_000);
    line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toHaveLength(0);
    expect(w.logs.mock.calls.flat().join("\n")).toContain(`[task-line] stop ${a.machine.id}`);
  });

  it("expires an admitted lease the home stopped renewing, and a queued ticket nobody polls", async () => {
    const w = await world();
    await cap(w, 1);
    const a = (await take(w, { key: "a", thread: "ta" })).ticket;
    const b = (await take(w, { key: "b", thread: "tb" })).ticket;
    await w.advance(90_000);
    expect((await poll(w, b.id)).state).toBe("expired");
    await w.advance(60_000);
    expect((await poll(w, a.id)).state).toBe("expired");
  });

  it("keeps an admitted lease alive while the home polls it", async () => {
    const w = await world();
    const a = (await take(w, { key: "a", thread: "ta" })).ticket;
    for (let i = 0; i < 10; i++) {
      await w.advance(60_000);
      expect((await poll(w, a.id)).state).toBe("admitted");
    }
  });

  it("at the cap with work waiting stops the longest-idle machine for the next ticket", async () => {
    const w = await world();
    await cap(w, 2);
    const a = (await take(w, { key: "a", thread: "ta" })).ticket;
    const b = (await take(w, { key: "b", thread: "tb" })).ticket;
    await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${b.id}`, OWNER_KEY));
    await w.advance(10_000);
    await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${a.id}`, OWNER_KEY));
    const c = (await take(w, { key: "c", thread: "tc" })).ticket;
    expect(c.state).toBe("admitted");
    const line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running.map((m: { id: string }) => m.id).sort()).toEqual([a.machine.id, c.machine.id].sort());
  });

  it("bounds the cap by TASK_MACHINES_MAX", async () => {
    const w = await world({ TASK_MACHINES_MAX: "4" });
    const refused = await cap(w, 5);
    expect(refused.status).toBe(400);
    expect((await body(refused)).error.code).toBe("invalid_cap");
    const settings = await body(await w.fetch(apiRequest("GET", "/v1/task-line/settings", OWNER_KEY)));
    expect(settings).toEqual({ settings: { cap: 4, idleMinutes: 5, sizes: { small: "small", large: "xlarge" } }, max: 4 });
  });

  it("refuses free-trial keys, unknown tickets and wrong methods", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("q");
    await startTrial(w, key);
    expect((await w.fetch(apiRequest("GET", "/v1/task-line", key))).status).toBe(403);
    expect((await w.fetch(apiRequest("GET", "/v1/task-line/tickets/tkt_aaaaaaaaaaaaaaaa", OWNER_KEY))).status).toBe(404);
    expect((await w.fetch(apiRequest("POST", "/v1/task-line", OWNER_KEY))).status).toBe(405);
    expect((await w.fetch(apiRequest("GET", "/v1/task-line", "ldc_wrong"))).status).toBe(401);
  });
});
