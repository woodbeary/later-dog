import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { ORIGIN, apiRequest, body, siteverify, trialKey, world } from "./fakes";

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

const start = async (key: string, ip: string, headers: Record<string, string> = {}, check?: (claim: string) => string) => {
  const claim = await sha256Hex(key);
  return new Request(`${ORIGIN}/v1/trials/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ claim, ...(check ? { turnstile: check(claim) } : {}) }),
  });
};

const passing = (claim: string) => `pass:${claim}`;

describe("a free trial the app starts by itself", () => {
  it("starts one trial per network once the browser check passes, and the key then works", async () => {
    const w = await world({ AI: { run: vi.fn(), gateway: vi.fn() } } as unknown as Record<string, string>);
    const checks = siteverify();
    const key = trialKey("a");
    const first = await w.fetch(await start(key, "203.0.113.7", {}, passing));
    expect(first.status).toBe(201);
    expect(await body(first)).toMatchObject({ trial: { state: "active", minutes: 30 }, included: ["decisions", "voice", "ai"] });
    expect(new URLSearchParams(String(checks.mock.calls[0]![1]?.body)).get("remoteip")).toBe("203.0.113.7");
    expect((await w.fetch(await start(key, "203.0.113.7", {}, passing))).status).toBe(200);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(200);
    const second = await w.fetch(await start(trialKey("b"), "203.0.113.7", {}, passing));
    expect(second.status).toBe(429);
    expect((await body(second)).error.code).toBe("trial_network_used");
    expect((await w.fetch(await start(trialKey("c"), "198.51.100.9", {}, passing))).status).toBe(201);
  });

  it("refuses a start without a passing browser check, so the app opens the trial page instead", async () => {
    const w = await world();
    const checks = siteverify();
    const missing = await w.fetch(await start(trialKey("e"), "203.0.113.9"));
    expect(missing.status).toBe(403);
    expect((await body(missing)).error.code).toBe("check_needed");
    expect(checks).not.toHaveBeenCalled();
    const otherClaim = await w.fetch(await start(trialKey("f"), "203.0.113.9", {}, () => "pass:not-this-claim"));
    expect(otherClaim.status).toBe(403);
    expect((await body(otherClaim)).error.code).toBe("check_failed");
    expect((await w.fetch(await start(trialKey("g"), "203.0.113.9", {}, () => "down"))).status).toBe(502);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", trialKey("e")))).status).toBe(401);
    expect((await w.fetch(await start(trialKey("e"), "203.0.113.9", {}, passing))).status).toBe(201);
  });

  it("refuses to start trials while its rate limiter is down", async () => {
    const w = await world({ TRIAL_FORM_LIMIT: { limit: async () => { throw new Error("limiter down"); } } } as unknown as Record<string, string>);
    siteverify();
    const response = await w.fetch(await start(trialKey("h"), "203.0.113.10", {}, passing));
    expect(response.status).toBe(429);
  });

  it("refuses browsers and malformed claims", async () => {
    const w = await world();
    expect((await w.fetch(await start(trialKey("d"), "203.0.113.8", { origin: "https://evil.example" }, passing))).status).toBe(403);
    const bad = new Request(`${ORIGIN}/v1/trials/start`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ claim: "x" }) });
    expect((await w.fetch(bad)).status).toBe(400);
  });
});
