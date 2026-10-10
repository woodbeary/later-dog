import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputersApiError, ComputersClient, ComputersConfigError, TRIAL_KEY, computersConnection, computersSelected, savedTrial, trialInUse,
} from "./cloud-computers.ts";
import { DEFAULT_TRIAL_API, endTrial, startTrial, trialStatus, type TrialOptions } from "./cloud-trial.ts";

const API = "https://trial.example.test/v1";
const EXPIRES = "2026-10-17T12:00:00.000Z";
const ENDED = "This free trial has ended or has not started yet.";
type Call = { url: URL; method: string; headers: Headers };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function trialService() {
  const calls: Call[] = [];
  const trials = new Map<string, { minutesLeft: number; ended: boolean }>();
  const world = {
    calls,
    trials,
    offer: { offered: true, minutes: 30, days: 7 } as unknown,
    offerStatus: 200,
    down: false,
    held: null as Promise<void> | null,
    claim(url: string) {
      trials.set(new URL(url).searchParams.get("claim") ?? "", { minutesLeft: 30, ended: false });
    },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: new URL(String(input)), method: init.method ?? "GET", headers: new Headers(init.headers) };
      calls.push(call);
      if (world.down) throw new TypeError("fetch failed");
      if (call.url.pathname === "/v1/trials") return json(world.offerStatus, world.offer);
      if (call.url.pathname === "/v1/trial" && call.method === "GET" && world.held) await world.held;
      const bearer = /^Bearer (\S+)$/.exec(call.headers.get("authorization") ?? "")?.[1];
      const trial = bearer ? trials.get(sha256(bearer)) : undefined;
      if (!trial || trial.ended) return json(401, { error: { code: "unauthorized", message: ENDED } });
      if (call.url.pathname === "/v1/computers" && call.method === "GET") return json(200, { computers: [] });
      if (call.url.pathname !== "/v1/trial") return json(404, { error: { code: "not_found", message: "no such route" } });
      if (call.method === "DELETE") {
        trial.ended = true;
        return json(200, { ended: true });
      }
      return json(200, { trial: { state: trial.minutesLeft >= 1 ? "active" : "used_up", minutes: 30, minutesLeft: trial.minutesLeft, expiresAt: EXPIRES } });
    }) as typeof fetch,
  };
  return world;
}

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try { await promise; } catch (error) { return error as Error & Record<string, unknown>; }
  throw new Error("expected a rejection");
}

let home: string;
let others: boolean;
let service: ReturnType<typeof trialService>;
let options: TrialOptions;
const keyFile = () => join(home, "computers-trial-key");
const stateFile = () => join(home, "computers-trial.json");
const savedKey = () => readFileSync(keyFile(), "utf8").trim();
const saved = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const mode = (file: string) => statSync(file).mode & 0o777;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "laterdog-trial-"));
  vi.stubEnv("LATERDOG_HOME", home);
  vi.stubEnv("LATERDOG_COMPUTERS_API", "");
  vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", "");
  vi.stubEnv("LATERDOG_TRIAL_API", API);
  others = false;
  service = trialService();
  options = { otherComputers: () => others, fetch: service.fetch };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("the free trial offer", () => {
  it("is offered only when no cloud computers are set up and the service offers it", async () => {
    expect(await trialStatus(options)).toEqual({ state: "offered", minutes: 30, days: 7 });
    expect(service.calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([`GET ${API}/trials`]);
    expect(service.calls[0].headers.has("authorization")).toBe(false);
    others = true;
    expect(await trialStatus(options)).toEqual({ state: "none" });
    expect(service.calls).toHaveLength(1);
  });

  it("is never offered when this version names no trial service", async () => {
    expect(DEFAULT_TRIAL_API).toBe("");
    vi.stubEnv("LATERDOG_TRIAL_API", "");
    expect(await trialStatus(options)).toEqual({ state: "none" });
    expect(await rejection(startTrial(options))).toMatchObject({ status: 409, message: "Free trials are not offered by this version of later.dog" });
    expect(service.calls).toHaveLength(0);
    expect(existsSync(keyFile())).toBe(false);
  });

  it("reads anything but a clear offer as no offer", async () => {
    for (const offer of [{ offered: false, minutes: 30, days: 7 }, { offered: true, minutes: 0, days: 7 }, { offered: "yes" }, "<html>"]) {
      service.offer = offer;
      expect(await trialStatus(options)).toEqual({ state: "none" });
    }
    service.offer = { offered: true, minutes: 30, days: 7 };
    service.offerStatus = 503;
    expect(await trialStatus(options)).toEqual({ state: "none" });
    service.down = true;
    expect(await trialStatus(options)).toEqual({ state: "none" });
  });

  it("refuses a trial service it must not send a key to", async () => {
    vi.stubEnv("LATERDOG_TRIAL_API", "http://trial.example.test/v1");
    expect(await rejection(startTrial(options))).toBeInstanceOf(ComputersConfigError);
    vi.stubEnv("LATERDOG_TRIAL_API", "https://user:secret@trial.example.test/v1");
    expect(await rejection(trialStatus(options))).toMatchObject({ status: 409, message: expect.not.stringContaining("secret") });
    expect(service.calls).toHaveLength(0);
    expect(existsSync(keyFile())).toBe(false);
  });
});

describe("starting a free trial", () => {
  it("makes a private key that leaves this machine only as its hash until the person passes the check", async () => {
    const pending = await startTrial(options);
    const key = savedKey();
    expect(key).toMatch(TRIAL_KEY);
    expect(pending).toEqual({ state: "pending", url: `https://trial.example.test/trial?claim=${sha256(key)}` });
    expect(mode(keyFile())).toBe(0o600);
    expect(mode(stateFile())).toBe(0o600);
    expect(saved()).toEqual({ api: API });
    expect(trialInUse()).toBe(false);
    expect(computersSelected()).toBe(false);
    expect(computersConnection()).toBeNull();
    expect(service.calls).toHaveLength(0);

    expect(await trialStatus(options)).toEqual(pending);
    expect(await startTrial(options)).toEqual(pending);
    expect(savedKey()).toBe(key);

    service.claim((pending as { url: string }).url);
    expect(await trialStatus(options)).toEqual({ state: "active", minutes: 30, minutesLeft: 30, expiresAt: EXPIRES });
    expect(saved()).toEqual({ api: API, confirmed: true });
    expect(trialInUse()).toBe(true);
    expect(computersSelected()).toBe(true);
    expect(computersConnection()).toEqual({ api: API, keyFile: keyFile(), source: "trial" });

    const trialCalls = service.calls.filter((call) => call.url.pathname === "/v1/trial");
    expect(trialCalls).toHaveLength(2);
    expect(trialCalls.every((call) => call.headers.get("authorization") === `Bearer ${key}`)).toBe(true);
    for (const call of service.calls) expect(call.url.href).not.toContain(key);
  });

  it("gives two clicks at once the same key", async () => {
    const [first, second] = await Promise.all([startTrial(options), startTrial(options)]);
    expect(second).toEqual(first);
    expect(first).toEqual({ state: "pending", url: expect.stringContaining(sha256(savedKey())) });
  });

  it("refuses beside other cloud computers, and once a trial has started", async () => {
    others = true;
    expect(await rejection(startTrial(options))).toMatchObject({ status: 409, message: "Cloud computers are already set up here" });
    expect(existsSync(keyFile())).toBe(false);
    others = false;
    const pending = await startTrial(options);
    service.claim((pending as { url: string }).url);
    await trialStatus(options);
    expect(await rejection(startTrial(options))).toMatchObject({ status: 409, message: "The free trial has already started" });
  });

  it("starts over when a pending trial lost its key", async () => {
    await startTrial(options);
    rmSync(keyFile());
    expect(await trialStatus(options)).toEqual({ state: "offered", minutes: 30, days: 7 });
    expect(existsSync(stateFile())).toBe(false);
  });
});

describe("a running free trial", () => {
  async function running() {
    const pending = await startTrial(options);
    service.claim((pending as { url: string }).url);
    await trialStatus(options);
    return service.trials.get(sha256(savedKey()))!;
  }

  it("shows the minutes left, then that they are used up", async () => {
    const trial = await running();
    trial.minutesLeft = 1;
    expect(await trialStatus(options)).toEqual({ state: "active", minutes: 30, minutesLeft: 1, expiresAt: EXPIRES });
    trial.minutesLeft = 0;
    expect(await trialStatus(options)).toEqual({ state: "used_up", minutes: 30, expiresAt: EXPIRES });
    expect(trialInUse()).toBe(true);
  });

  it("ends here once the service says it is over, and is never offered again", async () => {
    const trial = await running();
    trial.ended = true;
    expect(await trialStatus(options)).toEqual({ state: "ended" });
    expect(existsSync(keyFile())).toBe(false);
    expect(saved()).toEqual({ api: API, confirmed: true, ended: true });
    expect(trialInUse()).toBe(false);
    expect(computersSelected()).toBe(false);
    expect(await rejection(startTrial(options))).toMatchObject({ status: 409, message: "This installation has used its free trial" });
    const calls = service.calls.length;
    expect(await trialStatus(options)).toEqual({ state: "ended" });
    others = true;
    expect(await trialStatus(options)).toEqual({ state: "none" });
    expect(service.calls).toHaveLength(calls);
  });

  it("ends on the service first when the person ends it", async () => {
    const trial = await running();
    const key = savedKey();
    expect(await endTrial(options)).toEqual({ state: "ended" });
    expect(trial.ended).toBe(true);
    const ending = service.calls.find((call) => call.method === "DELETE");
    expect(ending?.url.href).toBe(`${API}/trial`);
    expect(ending?.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(existsSync(keyFile())).toBe(false);
    expect(trialInUse()).toBe(false);
  });

  it("keeps the trial when the service cannot be reached to end it", async () => {
    await running();
    service.down = true;
    const failure = await rejection(endTrial(options));
    expect(failure).toBeInstanceOf(ComputersApiError);
    expect(failure).toMatchObject({ httpStatus: 0 });
    expect(trialInUse()).toBe(true);
    expect(saved()).toEqual({ api: API, confirmed: true });
  });

  it("ends here when the service had already ended it", async () => {
    const trial = await running();
    trial.ended = true;
    expect(await endTrial(options)).toEqual({ state: "ended" });
    expect(trialInUse()).toBe(false);
  });

  it("gives way to computers.json for the connection", async () => {
    await running();
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: "https://computers.example.test/v1" }));
    expect(computersConnection()).toMatchObject({ source: "file" });
  });

  it("speaks the service's own words for a refusal, never the key's", async () => {
    const trial = await running();
    const key = savedKey();
    const client = new ComputersClient(computersConnection()!, { fetch: service.fetch });
    expect(await client.list()).toEqual([]);
    trial.ended = true;
    const refused = await rejection(client.list());
    expect(refused).toMatchObject({ httpStatus: 401, message: ENDED });
    expect(refused.message).not.toContain(key);
  });
});

describe("cancelling a pending trial", () => {
  it("forgets its key and offers the trial again", async () => {
    await startTrial(options);
    expect(await endTrial(options)).toEqual({ state: "offered", minutes: 30, days: 7 });
    expect(existsSync(keyFile())).toBe(false);
    expect(existsSync(stateFile())).toBe(false);
    expect(service.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("waits for a check already asking the service, so a cancel never strands a trial the person just passed", async () => {
    const pending = await startTrial(options);
    let release = () => {};
    service.held = new Promise<void>((resolve) => { release = resolve; });
    const checking = trialStatus(options);
    const cancelling = endTrial(options);
    await vi.waitFor(() => expect(service.calls.some((call) => call.url.pathname === "/v1/trial")).toBe(true));
    service.claim((pending as { url: string }).url);
    release();
    expect(await checking).toMatchObject({ state: "active", minutesLeft: 30 });
    expect(await cancelling).toEqual({ state: "ended" });
    expect(service.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect([...service.trials.values()]).toEqual([{ minutesLeft: 30, ended: true }]);
    expect(trialInUse()).toBe(false);
    expect(saved()).toEqual({ api: API, confirmed: true, ended: true });
  });
});

describe("the saved trial", () => {
  it("is ignored when it cannot be trusted", async () => {
    const write = (value: unknown) => writeFileSync(stateFile(), typeof value === "string" ? value : JSON.stringify(value));
    writeFileSync(keyFile(), `ldt_${"a".repeat(43)}\n`, { mode: 0o600 });
    write({ api: API, confirmed: true });
    expect(savedTrial()).toEqual({ api: API, confirmed: true });
    expect(trialInUse()).toBe(true);
    for (const value of [{ api: "http://evil.example.test/v1", confirmed: true }, { api: API, confirmed: true, extra: 1 }, { api: API, confirmed: false }, "{", "[]"]) {
      write(value);
      expect(savedTrial()).toBeNull();
      expect(trialInUse()).toBe(false);
    }
    writeFileSync(keyFile(), "ldc_not_a_trial_key\n");
    write({ api: API, confirmed: true });
    expect(trialInUse()).toBe(true);
    expect(() => new ComputersClient(computersConnection()!)).toThrow(/does not hold a later.dog free trial key/);
  });
});
