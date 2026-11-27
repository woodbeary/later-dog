import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { OWNER_KEY, type World, apiRequest, body, world } from "./fakes";

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function take(w: World, thread: string, size: "small" | "large" = "small") {
  const response = await w.fetch(apiRequest("POST", "/v1/task-line/tickets", OWNER_KEY, { body: { key: `home:${thread}:1`, thread, dog: "scout", size, class: "task" } }));
  return (await body(response)).ticket;
}

async function release(w: World, id: string) {
  return (await body(await w.fetch(apiRequest("DELETE", `/v1/task-line/tickets/${id}`, OWNER_KEY)))).ticket;
}

async function describeMachine(w: World, id: string) {
  const response = await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY));
  return { status: response.status, computer: (await body(response)).computer };
}

const flushes = (w: World, id: string) => w.containers.get(id)!.execs.filter((call) => call.cmd.join(" ").includes("flush-all")).length;

describe("task machines", () => {
  it("starts an admitted ticket's machine from the task image as a task kind that never appears in the computer list", async () => {
    const w = await world();
    const ticket = await take(w, "t1", "large");
    expect(ticket.state).toBe("admitted");
    const id = ticket.machine.id;
    const container = w.containers.get(id)!;
    expect(container.running).toBe(true);
    expect(container.starts[0]).toMatchObject({ image: "laterdog-task:test", instance: "standard-4" });
    const seen = await describeMachine(w, id);
    expect(seen.status).toBe(200);
    expect(seen.computer).toMatchObject({ id, kind: "task", size: "xlarge" });
    const listed = (await body(await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY)))).computers;
    expect(listed.map((computer: { id: string }) => computer.id)).not.toContain(id);
  });

  it("saves the folders and removes the machine five idle minutes after its ticket is released, never snapshotting it", async () => {
    const w = await world();
    const ticket = await take(w, "t1");
    const id = ticket.machine.id;
    const container = w.containers.get(id)!;
    await w.advance(2 * MINUTE);
    await settle();
    expect(container.running).toBe(true);
    await release(w, ticket.id);
    await w.advance(4 * MINUTE);
    await settle();
    expect(container.running).toBe(true);
    await w.advance(MINUTE + 30_000);
    await settle();
    expect(flushes(w, id)).toBe(1);
    expect(container.running).toBe(false);
    expect(container.snapshots).toBe(0);
    expect((await describeMachine(w, id)).status).toBe(404);
    const line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toEqual([]);
  });

  it("keeps a machine running when its folders cannot be saved, and retires it once a later save works", async () => {
    const w = await world();
    const ticket = await take(w, "t1");
    const id = ticket.machine.id;
    const container = w.containers.get(id)!;
    let failing = true;
    container.reply = (cmd) => (cmd.join(" ").includes("flush-all") && failing ? { exitCode: 1 } : undefined);
    await release(w, ticket.id);
    await w.advance(6 * MINUTE);
    await settle();
    expect(container.running).toBe(true);
    expect((await describeMachine(w, id)).computer.state).toBe("running");
    failing = false;
    await w.advance(6 * MINUTE);
    await settle();
    expect(container.running).toBe(false);
    expect((await describeMachine(w, id)).status).toBe(404);
  });

  it("reuses a thread's idle machine for its next turn without starting it again", async () => {
    const w = await world();
    const first = await take(w, "t1");
    await release(w, first.id);
    await w.advance(MINUTE);
    const second = (await body(await w.fetch(apiRequest("POST", "/v1/task-line/tickets", OWNER_KEY, { body: { key: "home:t1:2", thread: "t1", dog: "scout", size: "small", class: "task" } })))).ticket;
    expect(second.machine).toMatchObject({ id: first.machine.id, reused: true });
    expect(w.containers.get(first.machine.id)!.starts).toHaveLength(1);
  });

  it("starts three machines for five tickets at cap 3, and a released slot saves and stops its machine for the first in line", async () => {
    const w = await world();
    await w.fetch(apiRequest("PUT", "/v1/task-line/settings", OWNER_KEY, { body: { cap: 3 } }));
    const tickets = [];
    for (let i = 1; i <= 5; i++) tickets.push(await take(w, `t${i}`));
    expect(tickets.map((t) => t.state)).toEqual(["admitted", "admitted", "admitted", "queued", "queued"]);
    expect(tickets.slice(3).map((t) => t.place)).toEqual([1, 2]);
    expect([...w.containers.values()].filter((c) => c.running)).toHaveLength(3);
    await release(w, tickets[0].id);
    await settle();
    const fourth = (await body(await w.fetch(apiRequest("GET", `/v1/task-line/tickets/${tickets[3].id}`, OWNER_KEY)))).ticket;
    expect(fourth.state).toBe("admitted");
    expect(flushes(w, tickets[0].machine.id)).toBe(1);
    expect(w.containers.get(tickets[0].machine.id)!.running).toBe(false);
    expect([...w.containers.values()].filter((c) => c.running)).toHaveLength(3);
  });

  it("retires a task machine through the sleep route instead of snapshotting it, and tells the line", async () => {
    const w = await world();
    const ticket = await take(w, "t1");
    const id = ticket.machine.id;
    const slept = await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    expect(slept.status).toBe(200);
    expect(w.containers.get(id)!.snapshots).toBe(0);
    expect(flushes(w, id)).toBe(1);
    const line = (await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line;
    expect(line.running).toEqual([]);
  });

  it("takes a deleted task machine off the line, so the thread's next ticket starts a fresh one", async () => {
    const w = await world();
    const first = await take(w, "t1");
    const id = first.machine.id;
    expect((await w.fetch(apiRequest("DELETE", `/v1/computers/${id}`, OWNER_KEY))).status).toBe(200);
    await settle();
    expect((await body(await w.fetch(apiRequest("GET", "/v1/task-line", OWNER_KEY)))).line.running).toEqual([]);
    const next = (await body(await w.fetch(apiRequest("POST", "/v1/task-line/tickets", OWNER_KEY, { body: { key: "home:t1:2", thread: "t1", dog: "scout", size: "small", class: "task" } })))).ticket;
    expect(next.machine).toMatchObject({ id, reused: false });
    expect((await describeMachine(w, id)).computer).toMatchObject({ kind: "task" });
  });
});
