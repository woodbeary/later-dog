import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWarmEngines, ENGINE_BYTES, engineIdleLimit, RESERVE_BYTES, type MemoryGauge } from "./warm-engines.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function gauge(availableBytes: number) {
  const memory = { available: availableBytes };
  const read: MemoryGauge = { availableBytes: () => memory.available };
  return { memory, read };
}

function engine(name: string, closed: string[]) {
  return { pid: undefined, idleMs: null, close: (why: string) => closed.push(`${name}: ${why}`) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("warm engines on a home that can see its memory", () => {
  it("keeps a resting engine open for as long as memory is plentiful", () => {
    const closed: string[] = [];
    const { read } = gauge(3 * GIB);
    const warm = createWarmEngines({ memory: read });
    warm.rest({}, engine("Clover", closed));
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(closed).toEqual([]);
  });

  it("closes the engine that has rested longest first when memory runs short", () => {
    const closed: string[] = [];
    let clock = 0;
    const { memory, read } = gauge(3 * GIB);
    const warm = createWarmEngines({ memory: read, now: () => clock });
    for (const name of ["Clover", "Biscuit", "Churro"]) {
      clock += 1_000;
      warm.rest({}, engine(name, closed));
    }
    memory.available = GIB - 100 * MIB;
    vi.advanceTimersByTime(5_000);
    expect(closed).toEqual(["Clover: low memory"]);
  });

  it("closes as many resting engines as the shortfall needs", () => {
    const closed: string[] = [];
    let clock = 0;
    const { memory, read } = gauge(3 * GIB);
    const warm = createWarmEngines({ memory: read, now: () => clock });
    for (const name of ["Clover", "Biscuit", "Churro"]) {
      clock += 1_000;
      warm.rest({}, engine(name, closed));
    }
    memory.available = GIB - ENGINE_BYTES - 10 * MIB;
    vi.advanceTimersByTime(5_000);
    expect(closed).toEqual(["Clover: low memory", "Biscuit: low memory"]);
  });

  it("makes room before a new engine starts", () => {
    const closed: string[] = [];
    const { read } = gauge(GIB + 100 * MIB);
    const warm = createWarmEngines({ memory: read });
    warm.rest({}, engine("Clover", closed));
    expect(closed).toEqual([]);
    warm.makeRoom(ENGINE_BYTES);
    expect(closed).toEqual(["Clover: low memory"]);
  });

  it("never closes an engine that is working", () => {
    const closed: string[] = [];
    const { memory, read } = gauge(3 * GIB);
    const warm = createWarmEngines({ memory: read });
    const clover = {};
    warm.rest(clover, engine("Clover", closed));
    warm.wake(clover);
    memory.available = 100 * MIB;
    vi.advanceTimersByTime(60_000);
    warm.makeRoom(ENGINE_BYTES);
    expect(closed).toEqual([]);
  });

  it("keeps 1 GiB of memory free for the work dogs start", () => {
    const closed: string[] = [];
    expect(RESERVE_BYTES).toBe(GIB);
    const roomy = createWarmEngines({ memory: gauge(GIB + MIB).read });
    roomy.rest({}, engine("with 1 GiB and 1 MiB free", closed));
    const tight = createWarmEngines({ memory: gauge(GIB - MIB).read });
    tight.rest({}, engine("with 1 MiB short of 1 GiB free", closed));
    expect(closed).toEqual(["with 1 MiB short of 1 GiB free: low memory"]);
  });

  it("keeps a configured time limit on top of memory", () => {
    const closed: string[] = [];
    const warm = createWarmEngines({ memory: gauge(3 * GIB).read });
    warm.rest({}, { ...engine("Clover", closed), idleMs: 10_000 });
    vi.advanceTimersByTime(9_999);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(["Clover: idle"]);
  });
});

describe("warm engines where memory can't be seen", () => {
  it("closes a resting engine after its time limit", () => {
    const closed: string[] = [];
    const warm = createWarmEngines({ memory: null });
    warm.rest({}, { ...engine("Clover", closed), idleMs: 10 * 60_000 });
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(["Clover: idle"]);
  });

  it("starts the time limit again when an engine rests after working", () => {
    const closed: string[] = [];
    const warm = createWarmEngines({ memory: null });
    const clover = {};
    warm.rest(clover, { ...engine("Clover", closed), idleMs: 60_000 });
    vi.advanceTimersByTime(50_000);
    warm.wake(clover);
    vi.advanceTimersByTime(50_000);
    warm.rest(clover, { ...engine("Clover", closed), idleMs: 60_000 });
    vi.advanceTimersByTime(59_999);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(["Clover: idle"]);
  });
});

describe("which engine the system stops first when memory runs out", () => {
  it("marks a resting engine to go first and a working one as ordinary again", () => {
    const marks: [number, boolean][] = [];
    const warm = createWarmEngines({ memory: null, priority: (pid, resting) => marks.push([pid, resting]) });
    const clover = {};
    warm.rest(clover, { pid: 4242, idleMs: 60_000, close: () => {} });
    warm.wake(clover);
    warm.rest(clover, { pid: 4242, idleMs: 60_000, close: () => {} });
    warm.forget(clover);
    expect(marks).toEqual([[4242, true], [4242, false], [4242, true]]);
  });
});

describe("engineIdleLimit", () => {
  const memory = gauge(3 * GIB).read;

  it("sets no time limit where the home can see its memory", () => {
    expect(engineIdleLimit("CLAUDE", {}, memory)).toBeNull();
    expect(engineIdleLimit("ACP", {}, memory)).toBeNull();
  });

  it("keeps ten minutes where memory can't be seen", () => {
    expect(engineIdleLimit("CLAUDE", {}, null)).toBe(10 * 60_000);
  });

  it("honors a configured window either way", () => {
    expect(engineIdleLimit("CLAUDE", { LATERDOG_CLAUDE_SESSION_IDLE_MS: "120000" }, memory)).toBe(120_000);
    expect(engineIdleLimit("ACP", { LATERDOG_SESSION_IDLE_MS: "90000" }, null)).toBe(90_000);
  });
});


describe("thread engine ownership across adapters", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("waits for the exact idle owner to close before launching its replacement", async () => {
    const warm = createWarmEngines({ memory: null });
    const old = {};
    const closed = deferred();
    const order: string[] = [];
    warm.own("thread", old, { adapter: {}, idle: () => true, drain: async () => {
      order.push("stop");
      await closed.promise;
      warm.release("thread", old);
      order.push("closed");
    } });
    const replacement = warm.launch("thread", {}, new AbortController().signal, async () => { order.push("launch"); });
    expect(order).toEqual(["stop"]);
    closed.resolve();
    await replacement;
    expect(order).toEqual(["stop", "closed", "launch"]);
  });

  it("preserves same-account warm reuse and unrelated owners", async () => {
    const warm = createWarmEngines({ memory: null });
    const adapter = {};
    const drain = vi.fn();
    warm.own("same", {}, { adapter, idle: () => true, drain });
    warm.own("other", {}, { adapter: {}, idle: () => true, drain });
    await warm.launch("same", adapter, new AbortController().signal, async () => {});
    expect(drain).not.toHaveBeenCalled();
  });

  it("preserves active owners on cross-account launch and retirement", async () => {
    const warm = createWarmEngines({ memory: null });
    const drain = vi.fn();
    const active = true;
    const owner = {};
    warm.own("thread", owner, { adapter: {}, idle: () => !active, drain });
    const launch = vi.fn();
    await expect(warm.launch("thread", {}, new AbortController().signal, launch)).rejects.toThrow("still working");
    await expect(warm.retire("thread", owner)).rejects.toThrow("still working");
    expect(drain).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("never replaces an owner whose stop is unconfirmed", async () => {
    const warm = createWarmEngines({ memory: null });
    const drain = vi.fn(async () => { throw new Error("stop unconfirmed"); });
    warm.own("thread", {}, { adapter: {}, idle: () => true, drain });
    const launch = vi.fn();
    await expect(warm.launch("thread", {}, new AbortController().signal, launch)).rejects.toThrow("stop unconfirmed");
    await expect(warm.launch("thread", {}, new AbortController().signal, launch)).rejects.toThrow("stop unconfirmed");
    expect(() => warm.assertVacant("thread")).toThrow("stop was not confirmed");
    expect(drain).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it("lets Stop and a newer start win while the old idle owner drains", async () => {
    const warm = createWarmEngines({ memory: null });
    const old = {};
    const closed = deferred();
    const drain = vi.fn(async () => { await closed.promise; warm.release("thread", old); });
    warm.own("thread", old, { adapter: {}, idle: () => true, drain });
    const controller = new AbortController();
    const staleLaunch = vi.fn();
    const stale = warm.launch("thread", {}, controller.signal, staleLaunch);
    const rejected = expect(stale).rejects.toThrow("interrupted or replaced");
    controller.abort();
    const newestLaunch = vi.fn(async () => {});
    const newest = warm.launch("thread", {}, new AbortController().signal, newestLaunch);
    warm.release("thread", {});
    closed.resolve();
    await rejected;
    await newest;
    expect(drain).toHaveBeenCalledTimes(1);
    expect(staleLaunch).not.toHaveBeenCalled();
    expect(newestLaunch).toHaveBeenCalledTimes(1);
  });
  it.each(["stop", "newer"])("cancels a pending launch on %s without touching the replacement", async (reason) => {
    const warm = createWarmEngines({ memory: null });
    const gate = deferred();
    const controller = new AbortController();
    const stale = warm.launch("thread", {}, controller.signal, async (check) => { await gate.promise; check(); });
    const rejected = expect(stale).rejects.toThrow("interrupted or replaced");
    if (reason === "stop") controller.abort();
    else await warm.launch("thread", {}, new AbortController().signal, async () => {});
    gate.resolve();
    await rejected;
  });

});
