import { afterEach, describe, expect, it, vi } from "vitest";
import { CARRY_PART_BYTES, PACK_SCRIPT, UNPACK_SCRIPT, partsStream, storeParts } from "../src/carry";
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

const isPack = (cmd: string[]) => cmd.includes(PACK_SCRIPT);
const isUnpack = (cmd: string[]) => cmd.includes(UNPACK_SCRIPT);

async function running(w: World): Promise<string> {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} }));
  const id = (await body(response)).computer.id as string;
  await w.advance(MINUTE);
  return id;
}

async function read(w: World, id: string) {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).computer;
}

function storedKeys(w: World, id: string): string[] {
  const computer = w.computers.instances.get(id) as unknown as { ctx: { storage: { kv: { keys(): string[] } } } };
  return computer.ctx.storage.kv.keys();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}

function homeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return bytes;
}

describe("resetting a computer", () => {
  it("rebuilds it from its last snapshot and ends the old desktop links", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, OWNER_KEY));
    await w.advance(MINUTE);
    const link = await body(await w.fetch(apiRequest("POST", `/v1/computers/${id}/desktop`, OWNER_KEY)));
    const starts = container.starts.length;

    const reset = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY));
    expect(reset.status).toBe(200);
    expect((await body(reset)).computer.state).toBe("starting");
    expect(container.starts.length).toBe(starts + 1);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
    expect(container.snapshots).toBe(1);
    expect((await w.fetch(new Request(link.url))).status).toBe(403);
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("running");
  });

  it("starts from the image when the computer never slept", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    const reset = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY));
    expect(reset.status).toBe(200);
    expect(container.starts.at(-1)).toMatchObject({ image: "laterdog-desktop:test" });
    expect(container.starts.at(-1)).not.toHaveProperty("containerSnapshot");
  });
});

describe("updating a computer", () => {
  it("starts it on the current image and brings its files along", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    const home = homeBytes(Math.round(CARRY_PART_BYTES * 2.5));
    container.reply = (cmd) => (isPack(cmd) ? { stdout: home } : undefined);
    const starts = container.starts.length;

    const update = await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    expect(update.status).toBe(200);
    expect((await body(update)).computer.state).toBe("starting");
    expect(container.snapshots).toBe(1);
    expect(container.starts.length).toBe(starts + 1);
    expect(container.starts.at(-1)).toMatchObject({ image: "laterdog-desktop:test" });
    expect(storedKeys(w, id).filter((key) => key.startsWith("carry:"))).toEqual(["carry:0", "carry:1", "carry:2"]);

    await w.advance(MINUTE);
    expect(container.execs.some((entry) => isUnpack(entry.cmd))).toBe(true);
    expect(sameBytes(container.stdins.at(-1)!, home)).toBe(true);
    expect(storedKeys(w, id).some((key) => key.startsWith("carry:"))).toBe(false);
    expect((await read(w, id)).state).toBe("running");
  });

  it("refuses an asleep computer, so its files are never left behind", async () => {
    const w = await world();
    const id = await running(w);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    const update = await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    expect(update.status).toBe(409);
    expect((await body(update)).error.code).toBe("asleep");
  });

  it("leaves the computer as it was when its files cannot be gathered", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => (isPack(cmd) ? { exitCode: 2, stdout: "partial", stderr: "tar: disk error" } : undefined);
    const starts = container.starts.length;
    const update = await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    expect(update.status).toBe(502);
    expect((await body(update)).error).toMatchObject({ code: "pack_failed" });
    expect(container.running).toBe(true);
    expect(container.starts.length).toBe(starts);
    expect(storedKeys(w, id).some((key) => key.startsWith("carry:"))).toBe(false);
    expect((await read(w, id)).state).toBe("running");
  });

  it("goes back to the snapshot taken before the update when the files cannot be put back", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => {
      if (isPack(cmd)) return { stdout: homeBytes(1000) };
      if (isUnpack(cmd)) return { exitCode: 2, stderr: "tar: broken" };
      return undefined;
    };
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    await w.advance(MINUTE);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
    expect(storedKeys(w, id).some((key) => key.startsWith("carry:"))).toBe(false);
    expect(w.errors.mock.calls.some(([line]) => String(line).includes("goes back to how it was"))).toBe(true);
    expect((await read(w, id)).state).toBe("running");
  });

  it("refuses to sleep, reset or update again while an update is under way", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => (isPack(cmd) ? { stdout: homeBytes(10) } : undefined);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    for (const action of ["sleep", "reset", "update"]) {
      const response = await w.fetch(apiRequest("POST", `/v1/computers/${id}/${action}`, OWNER_KEY));
      expect(response.status, action).toBe(409);
      expect((await body(response)).error.code, action).toBe("updating");
    }
  });
});

describe("after an update", () => {
  async function updated(w: World): Promise<string> {
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => (isPack(cmd) ? { stdout: homeBytes(1000) } : undefined);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("running");
    return id;
  }

  it("saves the updated computer once its files are back, so it always has a snapshot", async () => {
    const w = await world();
    const id = await updated(w);
    const container = w.containers.get(id)!;
    expect(container.snapshots).toBe(2);
    const unpacked = container.execs.findIndex((entry) => isUnpack(entry.cmd));
    const synced = container.execs.findIndex((entry, index) => index > unpacked && entry.cmd.includes("sync"));
    expect(synced).toBeGreaterThan(unpacked);
  });

  it("resets to the updated computer with its files, never to the bare image", async () => {
    const w = await world();
    const id = await updated(w);
    const container = w.containers.get(id)!;
    container.reply = undefined;
    const execs = container.execs.length;
    const reset = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, OWNER_KEY));
    expect(reset.status).toBe(200);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-2" } });
    await w.advance(MINUTE);
    expect(container.execs.slice(execs).some((entry) => isUnpack(entry.cmd))).toBe(false);
    expect((await read(w, id)).state).toBe("running");
  });

  it("wakes from the updated computer after it stops unexpectedly", async () => {
    const w = await world();
    const id = await updated(w);
    const container = w.containers.get(id)!;
    await container.destroy();
    expect((await read(w, id)).state).toBe("error");
    const wake = await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, OWNER_KEY));
    expect(wake.status).toBe(200);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-2" } });
    await w.advance(MINUTE);
    expect((await read(w, id)).state).toBe("running");
  });

  it("goes back to the snapshot taken before the update when the updated computer cannot be saved", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => {
      if (isPack(cmd)) return { stdout: homeBytes(1000) };
      if (isUnpack(cmd)) container.failSnapshot = true;
      return undefined;
    };
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/update`, OWNER_KEY));
    await w.advance(MINUTE);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
    expect(storedKeys(w, id).some((key) => key.startsWith("carry:"))).toBe(false);
    expect(w.errors.mock.calls.some(([line]) => String(line).includes("could not be saved"))).toBe(true);
    container.failSnapshot = false;
    expect((await read(w, id)).state).toBe("running");
  });
});

describe("a trial computer whose minutes cannot be checked", () => {
  it("is asleep after a reset, not shown running with nothing behind it", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const created = await w.fetch(apiRequest("POST", "/v1/computers", key, { body: {} }));
    const id = (await body(created)).computer.id as string;
    await w.advance(MINUTE);
    for (const trial of w.trials.instances.values()) {
      vi.spyOn(trial as unknown as { budgetLeft(): Promise<number | null> }, "budgetLeft").mockRejectedValue(new Error("down"));
    }
    const reset = await w.fetch(apiRequest("POST", `/v1/computers/${id}/reset`, key));
    expect(reset.status).toBe(503);
    expect((await body(reset)).error.code).toBe("trial_unavailable");
    expect(w.containers.get(id)!.running).toBe(false);
    expect((await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, key)))).computer.state).toBe("sleeping");
  });
});

describe("carrying files between images", () => {
  it("splits a stream into parts and reads it back unchanged", async () => {
    const parts = new Map<string, Uint8Array>();
    const bytes = homeBytes(CARRY_PART_BYTES + 17);
    const stored = await storeParts(new Blob([bytes]).stream() as ReadableStream<Uint8Array>, (key, part) => parts.set(key, part));
    expect(stored).toEqual({ ok: true, parts: 2, bytes: bytes.byteLength });
    const back = new Uint8Array(await new Response(partsStream(stored.ok ? stored.parts : 0, (key) => parts.get(key))).arrayBuffer());
    expect(sameBytes(back, bytes)).toBe(true);
  });

  it("stops at the size limit", async () => {
    const stored = await storeParts(new Blob([homeBytes(100)]).stream() as ReadableStream<Uint8Array>, () => undefined, 50);
    expect(stored).toMatchObject({ ok: false, tooLarge: true });
  });
});
