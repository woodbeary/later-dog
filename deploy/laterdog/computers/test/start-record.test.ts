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

async function created(w: World): Promise<string> {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} }));
  return (await body(response)).computer.id;
}

async function read(w: World, id: string) {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).computer;
}

const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]));

describe("every start leaves a record and a line", () => {
  it("records a start that never answers as failed, with its reason, and writes one line that says why", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    container.rfbAnswers = () => { w.clock.now += MINUTE; return false; };
    await w.advance(10 * MINUTE);
    const computer = await read(w, id);
    expect(computer.state).toBe("error");
    expect(computer.error).toBe("The desktop did not become ready within 5 minutes.");
    expect(computer.lastStart).toMatchObject({ generation: 1, from: "image", outcome: "failed", reason: "The desktop did not become ready within 5 minutes." });
    expect(computer.lastStart.ms).toBeGreaterThan(5 * MINUTE);
    expect(lines(w.logs).filter((line) => line.startsWith(`laterdog computers: ${id} starting (generation 1,`))).toHaveLength(1);
    expect(lines(w.errors).filter((line) => line.includes(`${id} failed to boot: The desktop did not become ready within 5 minutes. (generation 1, from image,`))).toHaveLength(1);
  });

  it("records a restore from its snapshot with the snapshot's size, and how long it took to answer", async () => {
    const w = await world();
    const id = await created(w);
    await w.advance(MINUTE);
    expect((await read(w, id)).lastStart).toMatchObject({ generation: 1, from: "image", outcome: "ready" });
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, OWNER_KEY));
    await w.advance(MINUTE);
    const computer = await read(w, id);
    expect(computer.lastStart).toMatchObject({ generation: 2, from: "snapshot", restoreBytes: 4096, outcome: "ready" });
    expect(typeof computer.lastStart.ms).toBe("number");
    expect(lines(w.logs).some((line) => line.startsWith(`laterdog computers: ${id} starting (generation 2,`) && line.includes("of 4096 bytes"))).toBe(true);
    expect(lines(w.logs).some((line) => line.includes(`${id} screen answering`) && line.includes("4096 bytes restored"))).toBe(true);
  });

  it("writes a line when the platform refuses to start the container, which before left none", async () => {
    const w = await world();
    const id = await created(w);
    await w.advance(MINUTE);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    const container = w.containers.get(id)!;
    container.start = () => { throw new Error("no capacity for this instance type"); };
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, OWNER_KEY));
    const computer = await read(w, id);
    expect(computer).toMatchObject({ state: "error", error: "The computer could not start: no capacity for this instance type" });
    expect(computer.lastStart).toMatchObject({ generation: 2, from: "snapshot", outcome: "failed", reason: "The computer could not start: no capacity for this instance type" });
    expect(lines(w.errors).filter((line) => line.includes(`${id} failed to boot: The computer could not start: no capacity`))).toHaveLength(1);
  });

  it("stores a long reason cut to 300 characters and keeps the whole of it in the log line", async () => {
    const w = await world();
    const id = await created(w);
    await w.advance(MINUTE);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    const raw = `no capacity ${"y".repeat(2_000)}`;
    w.containers.get(id)!.start = () => { throw new Error(raw); };
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, OWNER_KEY));
    const computer = await read(w, id);
    expect(computer.error).toHaveLength(300);
    expect(computer.error.endsWith("…")).toBe(true);
    expect(computer.lastStart.reason).toBe(computer.error);
    expect(lines(w.errors).some((line) => line.includes(raw))).toBe(true);
  });

  it("says a computer that stopped while running stopped, without pointing at a wake", async () => {
    const w = await world();
    const id = await created(w);
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("running");
    w.containers.get(id)!.running = false;
    const computer = await read(w, id);
    expect(computer).toMatchObject({ state: "error", error: "The computer stopped unexpectedly, so changes since it last went to sleep are gone." });
    expect(computer.error).not.toMatch(/wake/i);
  });
});

describe("a start nothing is watching", () => {
  it("is watched again on the next request, and the computer then becomes ready", async () => {
    const w = await world();
    const id = await created(w);
    const slot = w.computers.slots.get(id)!;
    expect(slot.alarm).not.toBeNull();
    slot.alarm = null;
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("starting");
    expect(slot.alarm).not.toBeNull();
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("running");
  });

  it("is a failed start, in plain words, once it is older than the boot limit plus a minute", async () => {
    const w = await world();
    const id = await created(w);
    w.computers.slots.get(id)!.alarm = null;
    await w.advance(7 * MINUTE);
    const computer = await read(w, id);
    expect(computer).toMatchObject({ state: "error", error: "The computer did not finish starting." });
    expect(computer.lastStart).toMatchObject({ generation: 1, outcome: "failed", reason: "The computer did not finish starting." });
    expect(w.containers.get(id)!.running).toBe(false);
  });
});
