import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { runProcessStream, type StreamSocket } from "../src/process-stream";
import { DAY } from "../src/trial";
import { MAX_HOLDS, addHold, holdRefusal, parseHoldFrame, releaseHold } from "../src/workspace-holds";
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

const KEY = "a".repeat(24);
const OTHER = "b".repeat(24);

class Socket implements StreamSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  frame(value: unknown) { for (const listener of this.#listeners.get("message") ?? []) listener({ data: JSON.stringify(value) }); }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function running(w: World): Promise<string> {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} }));
  const id = (await body(response)).computer.id as string;
  await w.advance(MINUTE);
  return id;
}

type HoldingComputer = { workspaceHold(frame: unknown): Promise<{ ok: boolean; value?: unknown; refusal?: { code: string } }> };
const holder = (w: World, id: string) => w.computers.instances.get(id) as unknown as HoldingComputer;
const read = async (w: World, id: string) => (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).computer;

describe("workspace hold rules", () => {
  const now = Date.UTC(2026, 10, 9);

  it("accepts only well formed hold and release frames", () => {
    expect(parseHoldFrame({ channel: "hold", key: KEY, writtenAt: now })).toEqual({ channel: "hold", key: KEY, writtenAt: now });
    expect(parseHoldFrame({ channel: "release", key: KEY, through: now })).toEqual({ channel: "release", key: KEY, through: now });
    expect(parseHoldFrame({ channel: "hold", key: "../etc", writtenAt: now })).toBeNull();
    expect(parseHoldFrame({ channel: "hold", key: KEY, writtenAt: -1 })).toBeNull();
    expect(parseHoldFrame({ channel: "drop", key: KEY })).toBeNull();
  });

  it("keeps the latest write, caps the number of holds and refuses a release that is older than the work", () => {
    let holds = {};
    const first = addHold(holds, KEY, now, now);
    expect(first.ok).toBe(true);
    holds = (first as { holds: Record<string, number> }).holds;
    holds = (addHold(holds, KEY, now - 5, now) as { holds: Record<string, number> }).holds;
    expect(holds).toEqual({ [KEY]: now });
    expect(addHold(holds, KEY, now + 2 * DAY, now)).toMatchObject({ ok: false, refusal: { code: "bad_hold" } });
    const full = Object.fromEntries(Array.from({ length: MAX_HOLDS }, (_, index) => [index.toString(16).padStart(24, "0"), now]));
    expect(addHold(full, OTHER, now, now)).toMatchObject({ ok: false, refusal: { code: "too_many_holds" } });
    expect(releaseHold(holds, KEY, now - 1)).toMatchObject({ ok: false, refusal: { code: "newer_work" } });
    expect(releaseHold(holds, KEY, now)).toEqual({ ok: true, holds: {} });
    expect(releaseHold({}, KEY, now)).toEqual({ ok: true, holds: {} });
  });

  it("allows a reset only from a snapshot newer than the work and still inside its lifetime, and never an update or delete", () => {
    const holds = { [KEY]: now };
    expect(holdRefusal("reset", undefined, undefined, now)).toBeNull();
    expect(holdRefusal("delete", {}, undefined, now)).toBeNull();
    expect(holdRefusal("reset", holds, undefined, now)?.code).toBe("workspace_held");
    expect(holdRefusal("reset", holds, now - 1, now)?.code).toBe("workspace_held");
    expect(holdRefusal("reset", holds, now, now + DAY)).toBeNull();
    expect(holdRefusal("reset", holds, now, now + 28 * DAY)?.code).toBe("workspace_held");
    expect(holdRefusal("update", holds, now + 1, now + 2)?.code).toBe("workspace_held");
    expect(holdRefusal("delete", holds, now + 1, now + 2)?.code).toBe("workspace_held");
  });
});

describe("the process stream carries workspace holds", () => {
  it("answers hold and release frames before or after a process starts, without starting one", async () => {
    const socket = new Socket();
    const control = vi.fn(async (frame: unknown) => ({ ok: true as const, value: { frame } }));
    const start = vi.fn();
    runProcessStream(socket, { start, active: () => {}, finished: () => {}, control });
    socket.frame({ channel: "hold", id: 1, key: KEY, writtenAt: 5 });
    socket.frame({ channel: "release", id: 2, key: KEY, through: 5 });
    socket.frame({ channel: "hold", id: 3, key: "bad", writtenAt: 5 });
    await tick();
    expect(start).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
    expect(socket.sent).toContainEqual({ channel: "control", id: 1, ok: true, body: { frame: { channel: "hold", key: KEY, writtenAt: 5 } } });
    expect(socket.sent).toContainEqual({ channel: "control", id: 2, ok: true, body: { frame: { channel: "release", key: KEY, through: 5 } } });
    expect(socket.sent).toContainEqual({ channel: "control", id: 3, ok: false, message: "That workspace hold request is not valid." });
  });

  it("refuses holds on a host that cannot keep them", async () => {
    const socket = new Socket();
    runProcessStream(socket, { start: vi.fn(), active: () => {}, finished: () => {} });
    socket.frame({ channel: "hold", id: 7, key: KEY, writtenAt: 5 });
    await tick();
    expect(socket.sent).toContainEqual({ channel: "control", id: 7, ok: false, message: "This computer cannot hold workspaces." });
  });
});

describe("a computer that holds a dog's workspace", () => {
  it("refuses delete, keeps its listing, and deletes once the workspace is released", async () => {
    const w = await world();
    const id = await running(w);
    expect(await holder(w, id).workspaceHold({ channel: "hold", key: KEY, writtenAt: Date.now() })).toMatchObject({ ok: true });
    expect((await read(w, id)).workspaces).toMatchObject({ held: 1, captured: false });

    const refused = await w.fetch(apiRequest("DELETE", `/v1/computers/${id}`, OWNER_KEY));
    expect(refused.status).toBe(409);
    expect((await body(refused)).error.code).toBe("workspace_held");
    const listed = (await body(await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY)))).computers.map((computer: { id: string }) => computer.id);
    expect(listed).toContain(id);
    expect(w.containers.get(id)!.running).toBe(true);

    expect(await holder(w, id).workspaceHold({ channel: "release", key: KEY, through: Date.now() - 1 })).toMatchObject({ ok: false, refusal: { code: "newer_work" } });
    expect(await holder(w, id).workspaceHold({ channel: "release", key: KEY, through: Date.now() })).toMatchObject({ ok: true });
    expect((await read(w, id)).workspaces).toBeUndefined();
    expect((await w.fetch(apiRequest("DELETE", `/v1/computers/${id}`, OWNER_KEY))).status).toBe(200);
  });

  it("refuses reset until a snapshot newer than the work exists, then resets onto that snapshot", async () => {
    const w = await world();
    const id = await running(w);
    await holder(w, id).workspaceHold({ channel: "hold", key: KEY, writtenAt: Date.now() });
    const container = w.containers.get(id)!;
    const starts = container.starts.length;
    const refused = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY));
    expect(refused.status).toBe(409);
    expect((await body(refused)).error.code).toBe("workspace_held");
    expect(container.starts.length).toBe(starts);
    expect(container.running).toBe(true);

    await w.advance(1_000);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    expect((await read(w, id)).workspaces).toMatchObject({ held: 1, captured: true });
    const reset = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY));
    expect(reset.status).toBe(200);
    expect(container.starts.at(-1)).toHaveProperty("containerSnapshot");
  });

  it("refuses an update, which carries only the dog's home folder", async () => {
    const w = await world();
    const id = await running(w);
    await holder(w, id).workspaceHold({ channel: "hold", key: KEY, writtenAt: Date.now() });
    const container = w.containers.get(id)!;
    const update = await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    expect(update.status).toBe(409);
    expect((await body(update)).error.code).toBe("workspace_held");
    expect(container.snapshots).toBe(0);
    expect(container.running).toBe(true);
  });

  it("changes nothing for a computer that holds no workspace", async () => {
    const w = await world();
    const id = await running(w);
    expect((await read(w, id)).workspaces).toBeUndefined();
    expect((await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY))).status).toBe(200);
    await w.advance(MINUTE);
    expect((await w.fetch(apiRequest("DELETE", `/v1/computers/${id}`, OWNER_KEY))).status).toBe(200);
  });
});
