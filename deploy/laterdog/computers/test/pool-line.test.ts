import { afterEach, describe, expect, it, vi } from "vitest";
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

const MIB = 1024 ** 2;
const ENGINE = "/home/dog/.laterdog-engine/cli/x-1/node_modules/.bin/x";

class FakeAgent {
  readonly engines = new Map<string, { attached: boolean; memoryBytes: number; lastUsed: number }>();
  readonly evictions: Array<{ chat: string; reason: string }> = [];
  answering = true;
  opens = 0;

  constructor(
    readonly limit = 8192 * MIB,
    readonly base = 400 * MIB,
    readonly engineBytes = 300 * MIB,
  ) {}

  used(): number {
    return this.base + [...this.engines.values()].reduce((sum, engine) => sum + engine.memoryBytes, 0);
  }

  budget(): number {
    return Math.floor(this.limit / 100) * 75;
  }

  status() {
    return {
      host: { limitBytes: this.limit, usedBytes: this.used(), budgetBytes: this.budget(), estimateBytes: this.engineBytes, cpuShare: 0.05 },
      agent: { residentBytes: 3 * MIB, uptimeMs: 1 },
      engines: [...this.engines].map(([chat, engine]) => ({ chat, attached: engine.attached, memoryBytes: engine.memoryBytes })),
      evictions: this.evictions,
    };
  }

  idleOut(chat: string, reason = "idle") {
    this.engines.delete(chat);
    this.evictions.push({ chat, reason });
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (!this.answering) throw new Error("connection refused");
    const url = new URL(input);
    if (url.pathname === "/status") return Response.json(this.status());
    if (url.pathname === "/engines" && init?.method === "POST") {
      this.opens += 1;
      const spec = JSON.parse(String(init.body)) as { chat: string };
      const found = this.engines.get(spec.chat);
      if (found) return Response.json({ engine: { chat: spec.chat, warm: true, pid: 1, slot: 1, startMs: 0, memoryBytes: found.memoryBytes, reuses: 1, evicted: [] } });
      const evicted: string[] = [];
      const idle = [...this.engines].filter(([, engine]) => !engine.attached).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (this.used() + this.engineBytes > this.budget()) {
        const next = idle.shift();
        if (!next) return Response.json({ error: { code: "host_full", message: "full" } }, { status: 503 });
        this.idleOut(next[0], "memory");
        evicted.push(next[0]);
      }
      this.engines.set(spec.chat, { attached: false, memoryBytes: this.engineBytes, lastUsed: Date.now() });
      return Response.json({ engine: { chat: spec.chat, warm: false, pid: 2, slot: 1, startMs: 40, memoryBytes: this.engineBytes, reuses: 0, evicted } }, { status: 201 });
    }
    if (init?.method === "DELETE") {
      const chat = decodeURIComponent(url.pathname.split("/")[2]!);
      if (!this.engines.delete(chat)) return Response.json({ error: { code: "not_warm", message: "no" } }, { status: 404 });
      return Response.json({ closed: chat });
    }
    return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  };
}

function agents(w: World, make: () => FakeAgent = () => new FakeAgent()): Map<string, FakeAgent> {
  const made = new Map<string, FakeAgent>();
  const containers = w.containers;
  const get = w.poolHosts.get.bind(w.poolHosts);
  w.poolHosts.get = (id: { name: string }) => {
    const stub = get(id);
    const container = containers.get(id.name)!;
    if (!container.agent) {
      const agent = make();
      made.set(id.name.split(":").pop()!, agent);
      container.agent = agent;
    }
    return stub;
  };
  return made;
}

async function open(w: World, chat: string, extra: Record<string, unknown> = {}) {
  const response = await w.fetch(apiRequest("POST", "/v1/pool/engines", OWNER_KEY, { body: { chat, command: [ENGINE, "--serve"], ...extra } }));
  return { status: response.status, body: await body(response) };
}

async function pool(w: World) {
  return (await body(await w.fetch(apiRequest("GET", "/v1/pool", OWNER_KEY)))).pool;
}

async function tick(w: World, ms: number) {
  await w.advance(ms);
}

describe("the warm engine pool", () => {
  it("starts one always-on host on first use, opens an engine cold, then returns the chat to it warm", async () => {
    const w = await world();
    const made = agents(w);
    const first = await open(w, "chat-1");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ chat: "chat-1", state: "cold", sticky: false, scaledOut: true, stream: "/v1/pool/engines/chat-1/stream" });
    expect(made.size).toBe(1);
    const [hostId] = [...made.keys()];
    expect(first.body.host).toBe(hostId);
    const start = w.containers.get(`pool-host:${[...w.poolLines.instances.keys()][0]!.slice("pool-line:".length)}:${hostId}`)!.starts[0] as Record<string, unknown>;
    expect(start).toMatchObject({ instance: "standard-3", image: "laterdog-pool:test", entrypoint: ["/usr/local/bin/laterdog-pool-agent", "serve"] });

    const again = await open(w, "chat-1");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: "warm", sticky: true, host: hostId, scaledOut: false });

    const view = await pool(w);
    expect(view.hosts).toHaveLength(1);
    expect(view.hosts[0]).toMatchObject({ state: "ready", face: "live" });
    expect(view.hourlyUsd).toBeGreaterThan(0.07);
  });

  it("answers at once that a host is waking when the caller will not wait", async () => {
    const w = await world();
    agents(w, () => Object.assign(new FakeAgent(), { answering: false }));
    const waking = await open(w, "chat-1", { wait: false });
    expect(waking.status).toBe(202);
    expect(waking.body).toMatchObject({ state: "waking", scaledOut: true });
    expect((await pool(w)).hosts[0]).toMatchObject({ state: "starting", face: "waking" });
  });

  it("moves a chat whose engine idled out to a cold start and keeps it on the same host when there is room", async () => {
    const w = await world();
    const made = agents(w);
    await open(w, "chat-1");
    const agent = [...made.values()][0]!;
    agent.idleOut("chat-1");
    await tick(w, 31_000);
    const back = await open(w, "chat-1");
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ state: "cold", sticky: false });
    expect(agent.evictions).toEqual([{ chat: "chat-1", reason: "idle" }]);
  });

  it("lets a host close its least recently used idle engine under memory pressure and forgets that chat's route", async () => {
    const w = await world();
    const made = agents(w, () => new FakeAgent(4096 * MIB, 400 * MIB, 1000 * MIB));
    await open(w, "chat-1");
    await tick(w, 1_000);
    await open(w, "chat-2");
    await tick(w, 1_000);
    const third = await open(w, "chat-3");
    expect(third.body.engine.evicted).toEqual(["chat-1"]);
    const agent = [...made.values()][0]!;
    expect([...agent.engines.keys()]).toEqual(["chat-2", "chat-3"]);
    const stream = await w.fetch(apiRequest("GET", "/v1/pool/engines/chat-1/stream", OWNER_KEY, { headers: { upgrade: "websocket" } }));
    expect(stream.status).toBe(404);
    expect((await body(stream)).error.code).toBe("not_warm");
  });

  it("scales out when every engine on the only host is in a turn, and the new chat lands on the new host", async () => {
    const w = await world();
    const made = agents(w, () => new FakeAgent(4096 * MIB, 400 * MIB, 1000 * MIB));
    await open(w, "chat-1");
    await open(w, "chat-2");
    const firstAgent = [...made.values()][0]!;
    for (const engine of firstAgent.engines.values()) engine.attached = true;
    await tick(w, 31_000);
    const third = await open(w, "chat-3");
    expect(third.status).toBe(201);
    expect(made.size).toBe(2);
    expect(third.body.host).toBe([...made.keys()][1]);
    expect(third.body.scaledOut).toBe(true);
  });

  it("adds a host after two minutes above 80% and drains back to one after fifteen quiet minutes", async () => {
    const w = await world();
    const made = agents(w, () => new FakeAgent(4096 * MIB, 3500 * MIB, 10 * MIB));
    await open(w, "chat-1");
    for (let i = 0; i < 5; i++) await tick(w, 31_000);
    expect((await pool(w)).hosts.length).toBe(2);
    for (const agent of made.values()) (agent as { base: number }).base = 100 * MIB;
    for (let i = 0; i < 34; i++) await tick(w, 31_000);
    const view = await pool(w);
    expect(view.hosts.length).toBe(1);
  });

  it("restarts a host whose agent stops answering and drops its routes", async () => {
    const w = await world();
    const made = agents(w);
    await open(w, "chat-1");
    const agent = [...made.values()][0]!;
    agent.answering = false;
    for (let i = 0; i < 3; i++) await tick(w, 31_000);
    const view = await pool(w);
    expect(view.hosts[0]).toMatchObject({ state: "starting", face: "waking" });
    const stream = await w.fetch(apiRequest("GET", "/v1/pool/engines/chat-1/stream", OWNER_KEY, { headers: { upgrade: "websocket" } }));
    expect(stream.status).toBe(404);
  });

  it("refuses the free trial and a program outside the engine folder", async () => {
    const w = await world();
    agents(w);
    const bad = await w.fetch(apiRequest("POST", "/v1/pool/engines", OWNER_KEY, { body: { chat: "c", command: ["/bin/sh"] } }));
    expect(bad.status).toBe(400);
  });

  it("stops every host on request", async () => {
    const w = await world();
    agents(w);
    await open(w, "chat-1");
    const stopped = await w.fetch(apiRequest("DELETE", "/v1/pool", OWNER_KEY));
    expect((await body(stopped)).pool.hosts).toEqual([]);
  });
});
