import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { TRIAL_ID } from "../src/ids";
import type { Reservation } from "../src/registry";
import { DAY, type TrialRecord, trialListing } from "../src/trial";
import type { Activation } from "../src/trial-registry";
import { T0, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
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

const LIMIT = 30 * MINUTE;
const WINDOW = 7 * DAY;
const UNKNOWN_TRIAL = "trl_aaaaaaaaaaaaaaaa";

function start(keySha256: string, network: string, extra: { windowMs?: number; perDay?: number } = {}) {
  return { keySha256, network, limitMs: LIMIT, windowMs: WINDOW, perDay: 20, ...extra };
}

function started(activation: Activation): TrialRecord {
  if (!activation.ok) throw new Error(activation.refusal.message);
  return activation.trial;
}

function reserved(reservation: Reservation): string {
  if (!reservation.ok) throw new Error(reservation.refusal.message);
  return reservation.id;
}

async function registry(vars: Record<string, string> = {}) {
  const w = await world(vars);
  return { w, trials: w.trials.named("trials"), alarm: () => w.trials.slots.get("trials")!.alarm };
}

describe("TrialRegistry", () => {
  it("starts one trial per key and finds it by key or id", async () => {
    const { trials, alarm } = await registry();
    const first = await trials.activate(start("key-a", "net-1"));
    expect(first).toEqual({
      ok: true,
      replayed: false,
      trial: { id: expect.stringMatching(TRIAL_ID), createdAt: T0, expiresAt: T0 + WINDOW, limitMs: LIMIT, usedMs: 0 },
    });
    const trial = started(first);
    expect(alarm()).toBe(T0 + WINDOW);

    expect(await trials.activate(start("key-a", "net-2"))).toEqual({ ok: true, replayed: true, trial });
    expect(await trials.find("key-a")).toEqual(trial);
    expect(await trials.lookup(trial.id)).toEqual(trial);
    expect(await trials.budgetLeft(trial.id)).toBe(LIMIT);
    expect(await trials.find("key-b")).toBeNull();
    expect(await trials.lookup(UNKNOWN_TRIAL)).toBeNull();
    expect(await trials.budgetLeft(UNKNOWN_TRIAL)).toBeNull();
    expect(await trials.activate(start("key-b", "net-2"))).toMatchObject({ ok: true, replayed: false });
  });

  it("charges used time up to the trial's limit", async () => {
    const { trials } = await registry();
    const trial = started(await trials.activate(start("key-a", "net-1")));
    await trials.charge(trial.id, 10 * MINUTE);
    expect(await trials.budgetLeft(trial.id)).toBe(20 * MINUTE);
    for (const ms of [0, -5 * MINUTE, Number.NaN, Number.POSITIVE_INFINITY]) await trials.charge(trial.id, ms);
    expect(await trials.budgetLeft(trial.id)).toBe(20 * MINUTE);
    await trials.charge(trial.id, 1.4);
    expect(await trials.lookup(trial.id)).toMatchObject({ usedMs: 10 * MINUTE + 1 });
    await trials.charge(trial.id, 25 * MINUTE);
    expect(await trials.budgetLeft(trial.id)).toBe(0);
    expect(await trials.lookup(trial.id)).toMatchObject({ usedMs: LIMIT });
    await trials.charge(UNKNOWN_TRIAL, MINUTE);
    expect(await trials.lookup(trial.id)).toMatchObject({ usedMs: LIMIT });
  });

  it("stops finding a trial at its expiry and will not start that key again", async () => {
    const { w, trials } = await registry();
    const trial = started(await trials.activate(start("key-a", "net-1")));
    w.clock.now = T0 + WINDOW - 1;
    expect(await trials.find("key-a")).toEqual(trial);
    w.clock.now = T0 + WINDOW;
    expect(await trials.find("key-a")).toBeNull();
    expect(await trials.lookup(trial.id)).toBeNull();
    expect(await trials.budgetLeft(trial.id)).toBeNull();
    expect(await trials.activate(start("key-a", "net-2"))).toEqual({
      ok: false,
      refusal: { status: 409, code: "trial_ended", message: "This free trial has ended." },
    });
  });

  it("starts one trial per network until the window passes", async () => {
    const { w, trials } = await registry();
    started(await trials.activate(start("key-a", "net-1")));
    expect(await trials.activate(start("key-b", "net-1"))).toEqual({
      ok: false,
      refusal: { status: 429, code: "trial_network_used", message: "A free trial was already started from this network recently. Try again in a few days." },
    });
    started(await trials.activate(start("key-b", "net-2")));
    w.clock.now = T0 + WINDOW - 1;
    expect(await trials.activate(start("key-c", "net-1"))).toMatchObject({ ok: false, refusal: { code: "trial_network_used" } });
    w.clock.now = T0 + WINDOW;
    started(await trials.activate(start("key-c", "net-1")));
  });

  it("caps the trials started each UTC day without counting refusals or replays", async () => {
    const { w, trials } = await registry();
    const two = { perDay: 2 };
    started(await trials.activate(start("key-a", "net-1", two)));
    expect(await trials.activate(start("key-b", "net-1", two))).toMatchObject({ ok: false, refusal: { code: "trial_network_used" } });
    expect(await trials.activate(start("key-a", "net-9", two))).toMatchObject({ ok: true, replayed: true });
    started(await trials.activate(start("key-b", "net-2", two)));
    expect(await trials.activate(start("key-c", "net-3", two))).toEqual({
      ok: false,
      refusal: { status: 429, code: "trials_busy", message: "Today's free trials are all taken. Try again tomorrow." },
    });
    expect(await trials.activate(start("key-a", "net-9", two))).toMatchObject({ ok: true, replayed: true });
    w.clock.now = Date.UTC(2026, 9, 11) - 1;
    expect(await trials.activate(start("key-c", "net-3", two))).toMatchObject({ ok: false, refusal: { code: "trials_busy" } });
    w.clock.now = Date.UTC(2026, 9, 11);
    started(await trials.activate(start("key-c", "net-3", two)));
  });

  it("keeps its alarm at the earliest expiry", async () => {
    const { w, trials, alarm } = await registry();
    started(await trials.activate(start("key-a", "net-1")));
    expect(alarm()).toBe(T0 + WINDOW);
    w.clock.now = T0 + 60 * MINUTE;
    started(await trials.activate(start("key-b", "net-2")));
    expect(alarm()).toBe(T0 + WINDOW);
    started(await trials.activate(start("key-c", "net-3", { windowMs: DAY })));
    expect(alarm()).toBe(T0 + 60 * MINUTE + DAY);
  });

  it("ends expired trials at its alarm and arms the next expiry", async () => {
    const { w, trials, alarm } = await registry();
    const first = started(await trials.activate(start("key-a", "net-1", { windowMs: DAY })));
    await w.advance(60 * MINUTE);
    const second = started(await trials.activate(start("key-b", "net-2")));
    expect(alarm()).toBe(T0 + DAY);

    await w.advance(DAY - 60 * MINUTE);
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${first.id} ended`);
    expect(await trials.lookup(first.id)).toBeNull();
    expect(await trials.lookup(second.id)).toEqual(second);
    expect(alarm()).toBe(T0 + 60 * MINUTE + WINDOW);

    await w.advance(WINDOW);
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${second.id} ended`);
    expect(await trials.lookup(second.id)).toBeNull();
    expect(alarm()).toBeNull();
  });

  it("ends a trial whose computers are already gone", async () => {
    const { w, trials } = await registry();
    const trial = started(await trials.activate(start("key-a", "net-1")));
    const listing = w.registries.named(trialListing(trial.id));
    reserved(await listing.reserve({ size: "standard", max: 1 }));

    await trials.end(trial.id);
    expect(await listing.list()).toEqual([]);
    expect(await trials.lookup(trial.id)).toBeNull();
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${trial.id} ended`);
  });

  it("retries an hour later, or at the next expiry, when a trial's computer cannot be removed", async () => {
    const { w, trials, alarm } = await registry();
    const trial = started(await trials.activate(start("key-a", "net-1")));
    const later = started(await trials.activate(start("key-b", "net-2", { windowMs: WINDOW + 30 * MINUTE })));
    const listing = w.registries.named(trialListing(trial.id));
    const id = reserved(await listing.reserve({ size: "standard", max: 1 }));
    w.computers.named(id);
    const instance = w.computers.instances.get(id)!;
    instance.remove = async () => ({ ok: false, refusal: { status: 502, code: "container_error", message: "The container service is busy." } });

    await w.advance(WINDOW);
    expect(w.errors).toHaveBeenCalledWith(`laterdog computers: ending trial ${trial.id} failed: ${id}: The container service is busy.`);
    expect(await listing.list()).toHaveLength(1);
    expect(alarm()).toBe(T0 + WINDOW + 30 * MINUTE);

    await w.advance(30 * MINUTE);
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${later.id} ended`);
    expect(w.errors).toHaveBeenCalledTimes(2);
    expect(alarm()).toBe(T0 + WINDOW + 90 * MINUTE);

    Reflect.deleteProperty(instance, "remove");
    await w.advance(60 * MINUTE);
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${trial.id} ended`);
    expect(await listing.list()).toEqual([]);
    expect(alarm()).toBeNull();
  });
});

describe("a trial's computer listing", () => {
  it("answers whether it lists a computer, apart from the owner's listing", async () => {
    const { w } = await registry();
    const listing = w.registries.named(trialListing(UNKNOWN_TRIAL));
    const id = reserved(await listing.reserve({ size: "standard", max: 1 }));
    expect(await listing.has(id)).toBe(true);
    expect(await w.registries.named("registry").has(id)).toBe(false);
    expect(await listing.remove(id)).toBe(true);
    expect(await listing.has(id)).toBe(false);
    expect(await listing.remove(id)).toBe(false);
  });
});
