import { describe, expect, it } from "vitest";
import { ENGINES_PER_HOST, HEADROOM_ENGINES, type HostLoad, MINUTE, POOL_INSTANCE, POOL_VCPUS, type PoolHostRecord, hostHourlyUsd, nearlyFull, observe, parseEngineSpec, place, planScale, poolSettings } from "../src/pool-policy";

const GIB = 1024 ** 3;
const settings = poolSettings({ POOL_HOSTS_MAX: "4" });

function load(usedGib: number, warm: string[] = [], busy = 0): HostLoad {
  return { limitBytes: 8 * GIB, usedBytes: usedGib * GIB, budgetBytes: 6 * GIB, estimateBytes: 0.3 * GIB, engines: warm.length, busy, warm };
}

function host(id: string, state: PoolHostRecord["state"], hostLoad?: HostLoad, extra: Partial<PoolHostRecord> = {}): PoolHostRecord {
  return { id, state, startedAt: 0, ...(hostLoad ? { load: hostLoad } : {}), ...extra };
}

describe("placing a chat on the pool", () => {
  it("returns a chat to the host where its engine is still warm, even when another host has more room", () => {
    const hosts = [host("a", "ready", load(5, ["chat-1"])), host("b", "ready", load(1))];
    expect(place(hosts, "chat-1", "a")).toEqual({ host: "a", sticky: true, scaleOut: false });
  });

  it("places a cold chat on the host with the most room when its warm engine is gone", () => {
    const hosts = [host("a", "ready", load(5, [])), host("b", "ready", load(1))];
    expect(place(hosts, "chat-1", "a")).toEqual({ host: "b", sticky: false, scaleOut: false });
  });

  it("asks for a new host when every host is full, but still tries one whose idle engines it can close", () => {
    const full = [host("a", "ready", load(5.9, ["x", "y"], 1))];
    expect(place(full, "chat-1", undefined)).toEqual({ host: "a", sticky: false, scaleOut: true });
    const busy = [host("a", "ready", load(5.9, ["x"], 1))];
    expect(place(busy, "chat-1", undefined)).toEqual({ sticky: false, scaleOut: true });
  });

  it("never places on a host that is starting, draining or was skipped", () => {
    const hosts = [host("a", "starting"), host("b", "draining", load(1)), host("c", "ready", load(1))];
    expect(place(hosts, "chat-1", undefined, new Set(["c"]))).toEqual({ sticky: false, scaleOut: true });
  });
});

describe("scaling the pool", () => {
  it("keeps at least one host", () => {
    expect(planScale([], 0, settings).add).toBe(1);
    expect(planScale([host("a", "draining", load(0))], 0, settings)).toEqual({ add: 1, drain: [], remove: ["a"] });
  });

  it("adds a host only after every host has been above 80% for two minutes, up to the maximum", () => {
    let a = observe(host("a", "ready"), load(7), 0, settings);
    expect(planScale([a], MINUTE, settings).add).toBe(0);
    a = observe(a, load(7), 2 * MINUTE, settings);
    expect(planScale([a], 2 * MINUTE, settings).add).toBe(1);
    const fourHigh = ["a", "b", "c", "d"].map((id) => ({ ...a, id }));
    expect(planScale(fourHigh, 2 * MINUTE, settings).add).toBe(0);
    expect(planScale([a, host("b", "starting")], 2 * MINUTE, settings).add).toBe(0);
  });

  it("drains one quiet host below 30% for fifteen minutes, removes it once it has no busy engine, and never drains the last", () => {
    const quiet = (id: string, warm: string[]) => observe(host(id, "ready", undefined, { startedAt: id === "a" ? 0 : 1 }), load(1, warm), 0, settings);
    const pair = [quiet("a", ["x"]), quiet("b", [])];
    expect(planScale(pair, 14 * MINUTE, settings).drain).toEqual([]);
    expect(planScale(pair, 15 * MINUTE, settings).drain).toEqual(["b"]);
    expect(planScale([pair[0]!], 15 * MINUTE, settings).drain).toEqual([]);
    expect(planScale([{ ...pair[1]!, state: "draining", load: load(1, ["y"], 1) }], 0, settings).remove).toEqual([]);
  });

  it("marks a starting host ready when its agent first answers", () => {
    const ready = observe(host("a", "starting", undefined, { startedAt: 1000 }), load(0.5), 13_000, settings);
    expect(ready).toMatchObject({ state: "ready", readyAt: 13_000, checkedAt: 13_000 });
  });
});

describe("engine requests", () => {
  const engine = "/home/dog/.laterdog-engine/cli/x-1/node_modules/.bin/x";

  it("accepts an engine installed in the image with string env", () => {
    expect(parseEngineSpec({ chat: "dog_1.t2", command: [engine, "--print"], env: { TOKEN: "t" } })).toEqual({ ok: true, value: { chat: "dog_1.t2", command: [engine, "--print"], env: { TOKEN: "t" } } });
  });

  it("refuses other programs, path escapes, odd chat ids and lower-case env names", () => {
    for (const body of [
      { chat: "c", command: ["/bin/sh"] },
      { chat: "c", command: ["/home/dog/.laterdog-engine/cli/../../../bin/sh"] },
      { chat: "a/b", command: [engine] },
      { chat: "c", command: [engine], env: { path: "/" } },
      { chat: "c", command: [] },
    ]) {
      expect(parseEngineSpec(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("cost", () => {
  it("prices a standard-4 host from the documented memory, disk and active-CPU rates", () => {
    expect(hostHourlyUsd(0)).toBeCloseTo(0.11304, 4);
    expect(hostHourlyUsd(0.2)).toBeCloseTo(0.17064, 4);
  });

  it("gives every engine on a full host at least a third of a processor, since a burst of engine starts is bound by processor time", () => {
    expect(POOL_VCPUS / ENGINES_PER_HOST).toBeGreaterThanOrEqual(1 / 3);
    expect(POOL_INSTANCE).toBe("standard-4");
  });

  it("spreads a burst: a host at its engine cap takes no new chat while another host has room", () => {
    const many = Array.from({ length: ENGINES_PER_HOST }, (_, i) => `c${i}`);
    const hosts = [host("a", "ready", load(1, many, ENGINES_PER_HOST)), host("b", "ready", load(4))];
    expect(place(hosts, "new", undefined)).toEqual({ host: "b", sticky: false, scaleOut: false });
  });

  it("adds a host as soon as every ready host is near its engine cap, without waiting two minutes", () => {
    const busy = Array.from({ length: HEADROOM_ENGINES }, (_, i) => `c${i}`);
    const hosts = [host("a", "ready", load(2, busy))];
    expect(nearlyFull(hosts)).toBe(true);
    expect(planScale(hosts, 0, settings).add).toBe(1);
    expect(planScale([host("a", "ready", load(2, ["c0"]))], 0, settings).add).toBe(0);
  });
});

