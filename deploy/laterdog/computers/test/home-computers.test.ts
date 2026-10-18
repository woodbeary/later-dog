import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { MINUTE } from "../src/idle";
import { ComputersApi } from "../src/index";
import { DAY } from "../src/trial";
import { ORIGIN, T0, type World, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

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

function binding(w: World): ComputersApi {
  return new ComputersApi({} as ExecutionContext, w.env as unknown as Env);
}

async function grantHome(w: World, key: string): Promise<Response> {
  const request = new Request(`${ORIGIN}/v1/homes/grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claim: await sha256Hex(key) }),
  });
  return binding(w).fetch(request);
}

async function created(w: World, key: string, input: unknown = {}): Promise<string> {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", key, { body: input }));
  expect(response.status).toBe(201);
  return (await body(response)).computer.id;
}

async function state(w: World, key: string, id: string): Promise<string> {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, key)))).computer.state;
}

async function call(w: World, key: string, id: string, op: "wake" | "sleep"): Promise<Response> {
  return w.fetch(apiRequest("POST", `/v1/computers/${id}/${op}`, key));
}

describe("a later.dog Cloud home's computers", () => {
  it("gives every dog on a home its own computer, of any size, even with free trials switched off", async () => {
    const w = await world({ TRIALS_ENABLED: "false" });
    const key = trialKey("h");
    expect((await grantHome(w, key)).status).toBe(201);

    const scout = await created(w, key, { name: "Scout" });
    const juniper = await created(w, key, { name: "Juniper", size: "large" });
    expect(w.containers.get(juniper)!.starts).toMatchObject([{ instance: "standard-3" }]);
    await w.advance(MINUTE);
    expect([await state(w, key, scout), await state(w, key, juniper)]).toEqual(["running", "running"]);

    for (const id of [scout, juniper]) expect((await call(w, key, id, "sleep")).status).toBe(200);
    expect([await state(w, key, scout), await state(w, key, juniper)]).toEqual(["sleeping", "sleeping"]);
    for (const id of [scout, juniper]) expect((await call(w, key, id, "wake")).status).toBe(200);
    await w.advance(MINUTE);
    expect([await state(w, key, scout), await state(w, key, juniper)]).toEqual(["running", "running"]);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).computers).toHaveLength(2);
  });

  it("lets a home's computers stay awake for the deployment's idle time, not a free trial's", async () => {
    const w = await world();
    const key = trialKey("h");
    await grantHome(w, key);
    const id = await created(w, key);

    await w.advance(10 * MINUTE);
    expect(await state(w, key, id)).toBe("running");
    await w.advance(6 * MINUTE);
    expect(await state(w, key, id)).toBe("sleeping");
  });

  it("moves a home's older computers onto the deployment's idle time when they wake", async () => {
    const w = await world();
    const key = trialKey("h");
    const claim = await sha256Hex(key);
    const listing = await w.trials.named("trials").grant({ keySha256: claim, limitMs: 40 * 60 * MINUTE, windowMs: 90 * DAY });
    expect(listing.ok).toBe(true);
    const id = await created(w, key);
    await w.advance(6 * MINUTE);
    expect(await state(w, key, id)).toBe("sleeping");

    await grantHome(w, key);
    expect((await call(w, key, id, "wake")).status).toBe(200);
    await w.advance(10 * MINUTE);
    expect(await state(w, key, id)).toBe("running");
  });

  it("renews a home's grant in place, so the same key and its computers outlive the first window", async () => {
    const w = await world();
    const key = trialKey("h");
    const first = await body(await grantHome(w, key));
    expect(first).toMatchObject({ home: true, trial: { expiresAt: new Date(T0 + 90 * DAY).toISOString() } });
    const id = await created(w, key);
    await w.advance(20 * MINUTE);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial.minutesLeft).toBeLessThan(40 * 60);

    await w.advance(80 * DAY);
    const renewed = await grantHome(w, key);
    expect(renewed.status).toBe(200);
    expect((await body(renewed)).trial).toEqual({
      state: "active",
      minutes: 40 * 60,
      minutesLeft: 40 * 60,
      expiresAt: new Date(T0 + 20 * MINUTE + 170 * DAY).toISOString(),
    });

    await w.advance(20 * DAY);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial).toMatchObject({ state: "active" });
    expect((await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).computers).toMatchObject([{ id }]);
    expect((await call(w, key, id, "wake")).status).toBe(200);
  });

  it("refuses to end a home's grant with its own key, so every dog's computer survives", async () => {
    const w = await world();
    const key = trialKey("h");
    await grantHome(w, key);
    const scout = await created(w, key, { name: "Scout" });
    const juniper = await created(w, key, { name: "Juniper" });

    const ending = await w.fetch(apiRequest("DELETE", "/v1/trial", key));
    expect(ending.status).toBe(409);
    expect((await body(ending)).error).toMatchObject({ code: "home_grant", message: "This computer is part of your later.dog Cloud." });

    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial).toMatchObject({ state: "active" });
    expect((await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).computers).toHaveLength(2);
    await w.advance(MINUTE);
    expect([await state(w, key, scout), await state(w, key, juniper)]).toEqual(["running", "running"]);
  });

  it("keeps every computer on a home within the one shared allowance, however many are awake at once", async () => {
    const w = await world({ PLAN_HOURS: "1", IDLE_SLEEP_MINUTES: "240" });
    const key = trialKey("h");
    await grantHome(w, key);
    const ids: string[] = [];
    for (const name of ["A", "B", "C", "D", "E", "F"]) ids.push(await created(w, key, { name }));

    let awakeMinutes = 0;
    for (let minute = 0; minute < 240; minute++) {
      await w.advance(MINUTE);
      awakeMinutes += ids.filter((id) => w.containers.get(id)!.running).length;
    }
    expect(awakeMinutes).toBeGreaterThanOrEqual(55);
    expect(awakeMinutes).toBeLessThanOrEqual(60 + ids.length * 5 + ids.length);
    expect(ids.every((id) => !w.containers.get(id)!.running)).toBe(true);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial).toMatchObject({ state: "used_up" });
  });

  it("keeps a home's grant that was renewed while its expiry was being processed", async () => {
    const w = await world();
    const key = trialKey("h");
    const granted = await body(await grantHome(w, key));
    expect(granted.trial).toBeDefined();
    const holder = await w.trials.named("trials").holder(await sha256Hex(key));
    await w.trials.named("trials").end(holder!.trial.id, { expiredOnly: true });
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial).toMatchObject({ state: "active" });
  });

  it("still ends a home's grant and its computers when it is never renewed", async () => {
    const w = await world();
    const key = trialKey("h");
    await grantHome(w, key);
    const id = await created(w, key);
    await w.advance(91 * DAY);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(401);
    expect(w.containers.get(id)!.running).toBe(false);
    expect(await w.computers.named(id).describe()).toMatchObject({ ok: false, refusal: { status: 404 } });
  });
});

describe("a later.dog Cloud plan's computers", () => {
  it("gives every dog its own computer once the plan is paid, while a free trial keeps one", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("p");
    await startTrial(w, key);
    await created(w, key);
    const second = await w.fetch(apiRequest("POST", "/v1/computers", key, { body: {} }));
    expect((await body(second)).error.code).toBe("trial_one_computer");

    const keySha256 = await sha256Hex(key);
    await w.trials.named("trials").planPending({ keySha256, ref: "a".repeat(32), linkId: "LINK1", orderId: "ORDER1" });
    await w.trials.named("trials").applyPlan({
      keySha256,
      customerId: "CUST1",
      subscriptionId: "SUB1",
      status: "active",
      periodEnd: T0 + 30 * DAY,
      limitMs: 40 * 60 * MINUTE,
      graceMs: 3 * DAY,
    });
    await created(w, key);
    await created(w, key, { size: "large" });
    expect((await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).computers).toHaveLength(3);
  });

  it("puts a lapsed plan's computers back on the free trial's idle time when they wake", async () => {
    const w = await world();
    const key = trialKey("p");
    const keySha256 = await sha256Hex(key);
    const registry = w.trials.named("trials");
    await registry.grant({ keySha256, limitMs: 40 * 60 * MINUTE, windowMs: 90 * DAY });
    await registry.planPending({ keySha256, ref: "b".repeat(32), linkId: "LINK2", orderId: "ORDER2" });
    await registry.applyPlan({ keySha256, customerId: "CUST2", subscriptionId: "SUB2", status: "active", periodEnd: T0 + DAY, limitMs: 40 * 60 * MINUTE, graceMs: 0 });
    const id = await created(w, key);
    await w.advance(10 * MINUTE);
    expect(await state(w, key, id)).toBe("running");
    expect((await call(w, key, id, "sleep")).status).toBe(200);

    await w.advance(5 * DAY);
    expect((await call(w, key, id, "wake")).status).toBe(200);
    await w.advance(6 * MINUTE);
    expect(await state(w, key, id)).toBe("sleeping");
  });
});
