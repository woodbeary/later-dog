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

const start = async (key: string, ip: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/v1/trials/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ claim: await sha256Hex(key) }),
  });

describe("a free trial the app starts by itself", () => {
  it("starts one trial per network with no browser check, and the key then works", async () => {
    const w = await world({ AI: { run: vi.fn(), gateway: vi.fn() } } as unknown as Record<string, string>);
    siteverify();
    const key = trialKey("a");
    const first = await w.fetch(await start(key, "203.0.113.7"));
    expect(first.status).toBe(201);
    expect(await body(first)).toMatchObject({ trial: { state: "active", minutes: 30 }, included: ["decisions", "voice", "ai"] });
    expect((await w.fetch(await start(key, "203.0.113.7"))).status).toBe(200);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", key))).status).toBe(200);
    const second = await w.fetch(await start(trialKey("b"), "203.0.113.7"));
    expect(second.status).toBe(429);
    expect((await body(second)).error.code).toBe("trial_network_used");
    expect((await w.fetch(await start(trialKey("c"), "198.51.100.9"))).status).toBe(201);
  });

  it("refuses browsers and malformed claims", async () => {
    const w = await world();
    expect((await w.fetch(await start(trialKey("d"), "203.0.113.8", { origin: "https://evil.example" }))).status).toBe(403);
    const bad = new Request(`${ORIGIN}/v1/trials/start`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ claim: "x" }) });
    expect((await w.fetch(bad)).status).toBe(400);
  });
});
