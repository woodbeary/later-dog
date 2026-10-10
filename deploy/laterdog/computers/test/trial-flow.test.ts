import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { MINUTE } from "../src/idle";
import { DAY, trialListing } from "../src/trial";
import { IP, ORIGIN, OWNER_KEY, type Slot, T0, type World, apiRequest, body, siteverify, startTrial, trialForm, trialKey, world } from "./fakes";

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

const HOUR = 60 * MINUTE;
const NOT_FOUND = { status: 404, code: "not_found", message: "No computer with that id." };
const NO_TRIAL = { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." };
const NETWORK_USED = {
  status: 429,
  title: "The free trial could not start",
  message: "A free trial was already started from this network recently. Try again in a few days.",
};
const AGAIN = "Open the free trial link from later.dog again.";

type Shown = { status: number; title: string; message: string };

async function shown(response: Response): Promise<Shown> {
  const html = await response.text();
  const text = (pattern: RegExp) => (pattern.exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  return { status: response.status, title: text(/<h1>(.*?)<\/h1>/), message: text(/<p>(.*?)<\/p>/) };
}

async function refusal(response: Response): Promise<{ status: number; code: string; message: string }> {
  const { error } = await body(response);
  return { status: response.status, code: error.code, message: error.message };
}

function create(w: World, key: string, input?: unknown): Promise<Response> {
  return w.fetch(apiRequest("POST", "/v1/computers", key, input === undefined ? {} : { body: input }));
}

async function createdId(w: World, key: string, input?: unknown): Promise<string> {
  const response = await create(w, key, input);
  expect(response.status).toBe(201);
  return (await body(response)).computer.id;
}

async function inspect(w: World, key: string, id: string): Promise<Record<string, unknown>> {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, key)))).computer;
}

async function trialStatus(w: World, key: string): Promise<Record<string, unknown>> {
  return (await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).trial;
}

function firings(w: World, slot: Slot): number[] {
  const times: number[] = [];
  const fire = slot.fire;
  slot.fire = async () => {
    times.push(w.clock.now - T0);
    await fire();
  };
  return times;
}

describe("free trials, end to end", () => {
  it("starts a free trial from the browser page and reports its minutes to the app", async () => {
    const w = await world();
    const verify = siteverify();
    const key = trialKey("a");
    const claim = await sha256Hex(key);

    const form = await w.fetch(new Request(`${ORIGIN}/trial?claim=${claim}`));
    expect(form.status).toBe(200);
    expect(form.headers.get("referrer-policy")).toBe("strict-origin");
    const html = await form.text();
    expect(html).toContain(`<input type="hidden" name="claim" value="${claim}">`);
    expect(html).toContain(`data-sitekey="1x00000000000000000000AA" data-action="trial" data-cdata="${claim}"`);
    expect(html).toContain("<p>30 minutes of use within 7 days. No card needed. One free trial per network.</p>");
    expect(verify).not.toHaveBeenCalled();

    expect(await shown(await startTrial(w, key))).toEqual({
      status: 200,
      title: "Your free trial has started",
      message: "Go back to later.dog. You have 30 minutes of cloud computer time to use in the next 7 days.",
    });
    expect(verify).toHaveBeenCalledTimes(1);
    const [url, init] = verify.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      secret: "turnstile-secret-for-tests",
      response: `pass:${claim}`,
      remoteip: IP,
    });
    expect(w.logs).toHaveBeenCalledWith(expect.stringMatching(/^laterdog computers: trial trl_[a-z2-7]{16} started$/));

    const status = await w.fetch(apiRequest("GET", "/v1/trial", key));
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await body(status)).toEqual({
      trial: { state: "active", minutes: 30, minutesLeft: 30, expiresAt: new Date(T0 + 7 * DAY).toISOString() },
    });
    expect(await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).toEqual({ computers: [] });
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", claim)))).toEqual({ status: 401, code: "unauthorized", message: "The API key is not valid." });
  });

  it("answers a repeated form with the minutes left and allows one free trial per network", async () => {
    const w = await world();
    siteverify();
    expect((await startTrial(w, trialKey("a"))).status).toBe(200);
    expect(await shown(await startTrial(w, trialKey("a")))).toEqual({
      status: 200,
      title: "Your free trial has started",
      message: "Go back to later.dog. This free trial has 30 minutes left.",
    });

    expect(await shown(await startTrial(w, trialKey("b")))).toEqual(NETWORK_USED);
    expect(await shown(await startTrial(w, trialKey("b"), "::ffff:203.0.113.7"))).toEqual(NETWORK_USED);
    expect((await startTrial(w, trialKey("b"), "198.51.100.9")).status).toBe(200);

    expect((await startTrial(w, trialKey("c"), "2001:db8:1:2::1")).status).toBe(200);
    expect(await shown(await startTrial(w, trialKey("d"), "2001:db8:1:2:ffff::9"))).toEqual(NETWORK_USED);
    expect((await startTrial(w, trialKey("d"), "2001:db8:1:3::1")).status).toBe(200);

    await w.advance(7 * DAY - MINUTE);
    expect(await shown(await startTrial(w, trialKey("e")))).toEqual(NETWORK_USED);
    await w.advance(MINUTE);
    expect((await startTrial(w, trialKey("e"))).status).toBe(200);
  });

  it("caps how many free trials start each day", async () => {
    const w = await world({ TRIALS_PER_DAY: "1" });
    siteverify();
    expect((await startTrial(w, trialKey("a"))).status).toBe(200);
    const busy = { status: 429, title: "The free trial could not start", message: "Today's free trials are all taken. Try again tomorrow." };
    expect(await shown(await startTrial(w, trialKey("b"), "198.51.100.9"))).toEqual(busy);
    await w.advance(12 * HOUR - 1);
    expect(await shown(await startTrial(w, trialKey("b"), "198.51.100.9"))).toEqual(busy);
    await w.advance(1);
    expect((await startTrial(w, trialKey("b"), "198.51.100.9")).status).toBe(200);
  });

  it("refuses incomplete, foreign or unchecked forms without starting a trial", async () => {
    const w = await world();
    const verify = siteverify();
    const key = trialKey("a");
    const claim = await sha256Hex(key);
    const fields = { claim, "cf-turnstile-response": `pass:${claim}` };
    const incomplete = { status: 400, title: "This link is not complete", message: "Start the free trial from later.dog: Settings, then Cloud computers." };
    const unfinished = { status: 400, title: "The check did not finish", message: "Go back, wait for the check to pass, then press Start free trial." };
    const foreign = { status: 403, title: "This form came from another page", message: AGAIN };
    const unreadable = (status: number) => ({ status, title: "This form could not be read", message: AGAIN });
    const unidentified = { status: 400, title: "Your network could not be identified", message: "Try again from another network." };
    const withoutOrigin = trialForm(fields);
    withoutOrigin.headers.delete("origin");
    const withoutAddress = trialForm(fields);
    withoutAddress.headers.delete("cf-connecting-ip");

    const early: Array<[Request, Shown]> = [
      [new Request(`${ORIGIN}/trial`), incomplete],
      [new Request(`${ORIGIN}/trial?claim=${claim.toUpperCase()}`), incomplete],
      [new Request(`${ORIGIN}/trial?claim=${claim.slice(1)}`), incomplete],
      [trialForm(fields, { origin: "https://example.com" }), foreign],
      [trialForm(fields, { origin: "null" }), foreign],
      [withoutOrigin, foreign],
      [trialForm(fields, { "content-type": "application/json" }), unreadable(415)],
      [trialForm(fields, { "content-type": "multipart/form-data; boundary=x" }), unreadable(415)],
      [trialForm({ ...fields, padding: "x".repeat(8192) }), unreadable(413)],
      [trialForm({ ...fields, claim: "" }), incomplete],
      [trialForm({ "cf-turnstile-response": `pass:${claim}` }), incomplete],
      [trialForm({ claim }), unfinished],
      [trialForm({ claim, "cf-turnstile-response": "x".repeat(2049) }), unfinished],
      [trialForm(fields, { "cf-connecting-ip": "not an address" }), unidentified],
      [withoutAddress, unidentified],
    ];
    for (const [request, expected] of early) expect(await shown(await w.fetch(request)), `${request.method} ${request.url}`).toEqual(expected);
    expect(verify).not.toHaveBeenCalled();

    const checked: Array<[string, Shown]> = [
      ["down", { status: 502, title: "The check could not be confirmed", message: "Try again in a minute." }],
      ["fail", { status: 403, title: "The check did not pass", message: "Go back and try the check again." }],
      [`pass:${await sha256Hex(trialKey("b"))}`, { status: 403, title: "The check did not pass", message: "Go back and try the check again." }],
    ];
    for (const [token, expected] of checked) {
      expect(await shown(await w.fetch(trialForm({ claim, "cf-turnstile-response": token }))), token).toEqual(expected);
    }
    expect(verify).toHaveBeenCalledTimes(3);
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", key)))).toEqual(NO_TRIAL);

    const put = await w.fetch(new Request(`${ORIGIN}/trial`, { method: "PUT" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
    expect((await w.fetch(trialForm(fields, { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }))).status).toBe(200);
  });

  it("offers free trials only in the configured countries", async () => {
    const w = await world({ TRIAL_COUNTRIES: "US,CA" });
    siteverify();
    const from = async (key: string, ip: string, country?: string) => {
      const claim = await sha256Hex(key);
      const request = trialForm({ claim, "cf-turnstile-response": `pass:${claim}` }, { "cf-connecting-ip": ip });
      if (country !== undefined) Object.defineProperty(request, "cf", { value: { country } });
      return w.fetch(request);
    };
    const elsewhere = { status: 403, title: "Free trials are not offered here", message: "Free trials are not offered in your country yet." };
    expect(await shown(await from(trialKey("a"), "198.51.100.1", "FR"))).toEqual(elsewhere);
    expect(await shown(await from(trialKey("a"), "198.51.100.1", "T1"))).toEqual(elsewhere);
    expect(await shown(await from(trialKey("a"), "198.51.100.1"))).toEqual(elsewhere);
    expect((await from(trialKey("a"), "198.51.100.1", "CA")).status).toBe(200);
    expect((await from(trialKey("b"), "198.51.100.2", "us")).status).toBe(200);
  });

  it("keeps each free trial to its own computers", async () => {
    const w = await world();
    siteverify();
    const [a, b] = [trialKey("a"), trialKey("b")];
    await startTrial(w, a, "198.51.100.1");
    await startTrial(w, b, "198.51.100.2");
    const owned = await createdId(w, OWNER_KEY, { name: "owner" });
    const ofA = await createdId(w, a);
    const ofB = await createdId(w, b);
    const listed = async (key: string) => (await body(await w.fetch(apiRequest("GET", "/v1/computers", key)))).computers.map((computer: { id: string }) => computer.id);
    expect(await listed(OWNER_KEY)).toEqual([owned]);
    expect(await listed(a)).toEqual([ofA]);
    expect(await listed(b)).toEqual([ofB]);

    const attempts: Array<[string, string, unknown?]> = [
      ["GET", ""],
      ["PATCH", "", { name: "mine now" }],
      ["DELETE", ""],
      ["POST", "/wake"],
      ["POST", "/sleep"],
      ["POST", "/exec", { command: "cat /etc/hostname" }],
      ["GET", "/files?path=/home/dog/notes.txt"],
      ["PUT", "/files?path=/home/dog/notes.txt"],
      ["GET", "/screenshot"],
      ["POST", "/desktop"],
    ];
    for (const target of [owned, ofB]) {
      for (const [method, action, input] of attempts) {
        const response = await w.fetch(apiRequest(method, `/v1/computers/${target}${action}`, a, input === undefined ? {} : { body: input }));
        expect(await refusal(response), `${method} ${target}${action}`).toEqual(NOT_FOUND);
      }
    }
    expect(await inspect(w, OWNER_KEY, owned)).toMatchObject({ id: owned, name: "owner", state: "starting" });
    expect(await inspect(w, b, ofB)).toMatchObject({ id: ofB, name: ofB, state: "starting" });
    for (const id of [owned, ofB]) {
      expect(w.containers.get(id)!.running).toBe(true);
      expect(w.containers.get(id)!.starts).toHaveLength(1);
    }
  });

  it("gives a free trial one standard computer at a time, apart from the owner's limit", async () => {
    const w = await world({ MAX_COMPUTERS: "2" });
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const tooBig = { status: 403, code: "trial_size", message: "A free trial computer is the standard size." };
    expect(await refusal(await create(w, key, { size: "large" }))).toEqual(tooBig);
    expect(await refusal(await create(w, key, { size: "small" }))).toEqual(tooBig);

    const first = await create(w, key, { name: "Trial desk" });
    expect(first.status).toBe(201);
    const { computer } = await body(first);
    expect(computer).toMatchObject({ name: "Trial desk", size: "standard", state: "starting" });
    expect(w.containers.get(computer.id)!.starts).toEqual([
      {
        enableInternet: true,
        instance: "standard-2",
        env: { LATERDOG_COMPUTER_ID: computer.id },
        labels: { computer: computer.id, generation: "1" },
        image: "laterdog-desktop:test",
      },
    ]);
    expect(await refusal(await create(w, key))).toEqual({ status: 409, code: "limit_reached", message: "A free trial has one computer at a time; delete it first." });

    const owned = await createdId(w, OWNER_KEY, { size: "large" });
    expect(w.containers.get(owned)!.starts).toMatchObject([{ instance: "standard-3" }]);
    expect((await create(w, OWNER_KEY)).status).toBe(201);
    expect(await refusal(await create(w, OWNER_KEY))).toEqual({
      status: 409,
      code: "limit_reached",
      message: "This deployment allows 2 computers at once; delete one first.",
    });

    expect(await body(await w.fetch(apiRequest("DELETE", `/v1/computers/${computer.id}`, key)))).toEqual({ deleted: true });
    expect(w.containers.get(computer.id)!.running).toBe(false);
    expect((await create(w, key)).status).toBe(201);
  });

  it("refuses unknown, browser-borne and misplaced keys", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);

    const unknown = await w.fetch(apiRequest("GET", "/v1/computers", trialKey("z")));
    expect(unknown.headers.get("www-authenticate")).toBe('Bearer realm="laterdog-computers"');
    expect(await refusal(unknown)).toEqual(NO_TRIAL);

    const browser = {
      status: 403,
      code: "browser_origin",
      message: "The computers API is called from servers only; requests with an Origin header are refused.",
    };
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", key, { headers: { origin: ORIGIN } })))).toEqual(browser);
    expect(await refusal(await w.fetch(apiRequest("POST", "/v1/computers", key, { headers: { origin: "https://example.com" } })))).toEqual(browser);
    expect(await refusal(await w.fetch(new Request(`${ORIGIN}/v1/trials`, { headers: { origin: ORIGIN } })))).toEqual(browser);
    expect(await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).toEqual({ offered: true, minutes: 30, days: 7 });

    const notTrial = { status: 404, code: "no_trial", message: "This key is not a free trial key." };
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", OWNER_KEY)))).toEqual(notTrial);
    expect(await refusal(await w.fetch(apiRequest("DELETE", "/v1/trial", OWNER_KEY)))).toEqual(notTrial);

    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/computers", "ldt_short")))).toEqual({
      status: 401,
      code: "unauthorized",
      message: "The API key is not valid.",
    });
    expect(await refusal(await w.fetch(new Request(`${ORIGIN}/v1/trial`)))).toEqual({
      status: 401,
      code: "unauthorized",
      message: "Send the API key as Authorization: Bearer ldc_...",
    });
  });

  it("puts a trial computer to sleep when the trial's minutes run out", async () => {
    const w = await world({ TRIAL_IDLE_SLEEP_MINUTES: "60" });
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const id = await createdId(w, key);
    const fired = firings(w, w.computers.slots.get(id)!);

    await w.advance(10 * MINUTE);
    expect(await trialStatus(w, key)).toEqual({ state: "active", minutes: 30, minutesLeft: 20, expiresAt: new Date(T0 + 7 * DAY).toISOString() });
    expect(await inspect(w, key, id)).toMatchObject({ state: "running" });

    await w.advance(20 * MINUTE);
    expect(fired).toEqual([1000, 5 * MINUTE + 1000, 10 * MINUTE + 1000, 15 * MINUTE + 1000, 20 * MINUTE + 1000, 25 * MINUTE + 1000, 30 * MINUTE]);
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: ${id} is going to sleep (budget)`);
    const container = w.containers.get(id)!;
    expect(container.running).toBe(false);
    expect(container.snapshots).toBe(1);
    expect(await inspect(w, key, id)).toMatchObject({ state: "sleeping", snapshotAt: new Date(T0 + 30 * MINUTE).toISOString() });
    expect(await trialStatus(w, key)).toMatchObject({ state: "used_up", minutesLeft: 0 });

    expect(await refusal(await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, key)))).toEqual({
      status: 409,
      code: "trial_used_up",
      message: "This free trial has no minutes left.",
    });
    expect(container.starts).toHaveLength(1);
    expect(w.computers.slots.get(id)!.alarm).toBeNull();
  });

  it("stops a trial computer that cannot be saved ten minutes after its minutes run out", async () => {
    const w = await world({ TRIAL_IDLE_SLEEP_MINUTES: "60" });
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const id = await createdId(w, key);
    const container = w.containers.get(id)!;
    container.failSnapshot = true;

    await w.advance(30 * MINUTE);
    expect(await inspect(w, key, id)).toMatchObject({ state: "running" });
    expect(w.errors).toHaveBeenCalledWith(`laterdog computers: ${id} snapshot failed (budget): The snapshot service is busy.`);
    await w.advance(10 * MINUTE - 1);
    expect(container.running).toBe(true);

    await w.advance(1);
    expect(container.running).toBe(false);
    expect(await inspect(w, key, id)).toMatchObject({
      state: "error",
      error: "This free trial ran out of minutes and the computer could not be saved, so it was stopped.",
    });
    expect(w.computers.slots.get(id)!.alarm).toBeNull();
    expect(await trialStatus(w, key)).toMatchObject({ state: "used_up", minutesLeft: 0 });
    expect(await refusal(await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, key)))).toMatchObject({ status: 409, code: "trial_used_up" });
  });

  it("stops the meter while a trial computer sleeps and wakes it from its snapshot", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const id = await createdId(w, key);
    const owned = await createdId(w, OWNER_KEY);

    await w.advance(6 * MINUTE);
    expect(await inspect(w, key, id)).toMatchObject({ state: "sleeping" });
    expect(await inspect(w, OWNER_KEY, owned)).toMatchObject({ state: "running" });
    await w.advance(54 * MINUTE);
    expect(await inspect(w, OWNER_KEY, owned)).toMatchObject({ state: "sleeping" });
    expect(await trialStatus(w, key)).toMatchObject({ state: "active", minutesLeft: 24 });

    const woke = await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, key));
    expect((await body(woke)).computer).toMatchObject({ state: "starting" });
    expect(w.containers.get(id)!.starts[1]).toEqual({
      enableInternet: true,
      instance: "standard-2",
      env: { LATERDOG_COMPUTER_ID: id },
      labels: { computer: id, generation: "2" },
      containerSnapshot: { id: "snapshot-1" },
    });
    await w.advance(10 * MINUTE);
    expect(await inspect(w, key, id)).toMatchObject({ state: "sleeping" });
    expect(await trialStatus(w, key)).toMatchObject({ state: "active", minutesLeft: 19 });
  });

  it("ends a free trial on request and deletes its computer", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const id = await createdId(w, key);
    await w.advance(2 * MINUTE);
    expect(await trialStatus(w, key)).toMatchObject({ minutesLeft: 28 });

    expect(await body(await w.fetch(apiRequest("DELETE", "/v1/trial", key)))).toEqual({ ended: true });
    expect(w.containers.get(id)!.running).toBe(false);
    expect(w.computers.slots.get(id)!.alarm).toBeNull();
    expect(await refusal(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).toEqual(NOT_FOUND);
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", key)))).toEqual(NO_TRIAL);
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/computers", key)))).toEqual(NO_TRIAL);
    expect(await shown(await startTrial(w, key))).toEqual(NETWORK_USED);
  });

  it("deletes a free trial's computers when it expires, retrying an hour later after a failure", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const trial = (await w.trials.named("trials").find(await sha256Hex(key)))!;
    const id = await createdId(w, key);
    const owned = await createdId(w, OWNER_KEY);
    const instance = w.computers.instances.get(id)!;
    instance.remove = async () => {
      throw new Error("The container service is busy.");
    };

    await w.advance(7 * DAY);
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/trial", key)))).toEqual(NO_TRIAL);
    expect(await refusal(await w.fetch(apiRequest("GET", "/v1/computers", key)))).toEqual(NO_TRIAL);
    expect(await refusal(await create(w, key))).toEqual(NO_TRIAL);
    expect(await w.registries.named(trialListing(trial.id)).list()).toHaveLength(1);
    expect(w.errors).toHaveBeenCalledWith(`laterdog computers: ending trial ${trial.id} failed: The container service is busy.`);
    expect(w.trials.slots.get("trials")!.alarm).toBe(T0 + 7 * DAY + HOUR);

    Reflect.deleteProperty(instance, "remove");
    await w.advance(HOUR);
    expect(await w.registries.named(trialListing(trial.id)).list()).toEqual([]);
    expect(w.trials.slots.get("trials")!.alarm).toBeNull();
    expect(w.logs).toHaveBeenCalledWith(`laterdog computers: trial ${trial.id} ended`);
    expect(await refusal(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).toEqual(NOT_FOUND);
    expect(await inspect(w, OWNER_KEY, owned)).toMatchObject({ id: owned, state: "sleeping" });
  });

  it("switches free trials off without stopping the trials already running or the owner's computers", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    const claim = await sha256Hex(key);
    await startTrial(w, key);
    const id = await createdId(w, key);
    await w.advance(MINUTE);
    expect(await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).toEqual({ offered: true, minutes: 30, days: 7 });

    w.env.TRIALS_ENABLED = "false";
    expect(await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).toEqual({ offered: false, minutes: 30, days: 7 });
    const closed = { status: 503, title: "Free trials are not available", message: "Free trials are switched off on this service right now." };
    expect(await shown(await w.fetch(new Request(`${ORIGIN}/trial?claim=${claim}`)))).toEqual(closed);
    expect(await shown(await startTrial(w, trialKey("b"), "198.51.100.9"))).toEqual(closed);
    const off = { status: 503, code: "trials_off", message: "Free trials are switched off on this service right now." };
    expect(await refusal(await create(w, key))).toEqual(off);
    expect(await refusal(await w.fetch(apiRequest("POST", `/v1/computers/${id}/wake`, key)))).toEqual(off);

    expect(await trialStatus(w, key)).toMatchObject({ state: "active", minutesLeft: 29 });
    expect(await inspect(w, key, id)).toMatchObject({ state: "running" });
    expect((await body(await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, key)))).computer).toMatchObject({ state: "sleeping" });
    expect(await body(await w.fetch(apiRequest("DELETE", `/v1/computers/${id}`, key)))).toEqual({ deleted: true });
    expect((await create(w, OWNER_KEY)).status).toBe(201);
  });
});
