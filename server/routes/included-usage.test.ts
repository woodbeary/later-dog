import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createIncludedUsageRoutes } from "./included-usage.ts";
import { dispatchRoutes } from "./table.ts";

const API = "https://usage.example.test/v1";
const KEY = `ldt_${"k".repeat(43)}`;
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USAGE = {
  owner: false,
  tier: "home",
  today: "2026-10-30",
  days: [
    { day: "2026-10-29", used: {}, micros: 0 },
    { day: "2026-10-30", used: { transcribe_seconds: 28, ai_tokens: 1200, retired_kind: 4 }, micros: 310 },
  ],
  limits: { transcribe_seconds: 3600, ai_tokens: 1_500_000, grok_tokens: 200_000 },
};

const REPORT = {
  today: "2026-10-30",
  days: ["2026-10-29", "2026-10-30"],
  usage: [{ day: "2026-10-30", kind: "ai_tokens", used: 475_961 }, { day: "2026-10-30", kind: "retired_kind", used: 3 }],
  active: [{ day: "2026-10-30", installs: 2 }],
  activeInstalls: 2,
  spend: [
    { day: "2026-10-30", service: "chat", provider: "cloudflare", units: 58_117, micros: 56_318 },
    { day: "2026-10-30", service: "chat", provider: "someone_new", units: 1, micros: 1 },
  ],
  top: [{ label: "trl_example", tier: "home", owner: false, micros: 56_614, services: [{ service: "chat", units: 59_595, micros: 56_614 }] }],
  grants: [],
};

const servers: Server[] = [];
let home: string;
let clock: number;
let calls: { url: string; method: string; authorization: string | null; origin: string | null; body: string | null }[];
let reply: (url: URL, init: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "laterdog-included-usage-"));
  vi.stubEnv("LATERDOG_HOME", home);
  clock = Date.parse("2026-10-30T12:00:00Z");
  calls = [];
  reply = (url) => url.pathname === "/v1/usage" ? answer(200, USAGE) : answer(200, REPORT);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function joinTrial(state: Record<string, unknown> = { api: API, confirmed: true, included: ["decisions", "voice", "ai"] }) {
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify(state));
  writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
}

const service = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  calls.push({ url: String(input), method: init.method ?? "GET", authorization: headers.get("authorization"), origin: headers.get("origin"), body: typeof init.body === "string" ? init.body : null });
  return reply(new URL(String(input)), init);
}) as typeof fetch;

async function serve() {
  const routes = [createIncludedUsageRoutes({ fetch: service, now: () => clock })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { thrown: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
  };
}

describe("the included usage routes", () => {
  it("answers with nothing when this later.dog has no included allowance", async () => {
    const call = await serve();
    expect(await call("GET", "/api/included-usage")).toMatchObject({ status: 200, body: { usage: null } });
    expect(await call("GET", "/api/owner-usage")).toMatchObject({ status: 200, body: { report: null } });
    expect((await call("PUT", "/api/owner-usage/grants", { grants: [] })).status).toBe(404);
    joinTrial({ api: API, confirmed: true, ended: true });
    expect(await call("GET", "/api/included-usage")).toMatchObject({ status: 200, body: { usage: null } });
    expect(calls).toEqual([]);
  });

  it("reads this install's own usage with its key, drops kinds it does not know, and keeps it for a minute", async () => {
    joinTrial();
    const call = await serve();
    const first = await call("GET", "/api/included-usage");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.body).toEqual({ usage: { ...USAGE, days: [USAGE.days[0], { ...USAGE.days[1], used: { transcribe_seconds: 28, ai_tokens: 1200 } }] } });
    expect(calls).toEqual([{ url: `${API}/usage?days=30`, method: "GET", authorization: `Bearer ${KEY}`, origin: null, body: null }]);

    await call("GET", "/api/included-usage");
    expect(calls).toHaveLength(1);
    clock += 60_000;
    await call("GET", "/api/included-usage");
    expect(calls).toHaveLength(2);

    await call("GET", "/api/included-usage?days=7");
    await call("GET", "/api/included-usage?days=500");
    await call("GET", "/api/included-usage?days=2.5");
    expect(calls.slice(2).map((sent) => sent.url)).toEqual([`${API}/usage?days=7`]);
  });

  it("passes the owner's report through and hides it from a key the service does not own", async () => {
    joinTrial();
    const call = await serve();
    const report = await call("GET", "/api/owner-usage?days=30");
    expect(report.status).toBe(200);
    expect(report.body.report).toEqual({
      ...REPORT,
      usage: [REPORT.usage[0]],
      spend: [REPORT.spend[0]],
    });
    expect(calls.map((sent) => sent.url)).toEqual([`${API}/usage/owner?days=30`]);

    reply = () => answer(404, { error: { code: "not_found", message: "Not found." } });
    expect(await call("GET", "/api/owner-usage?days=14")).toMatchObject({ status: 200, body: { report: null } });
    reply = () => answer(401, { error: { code: "unauthorized", message: "This free trial has ended or has not started yet." } });
    expect(await call("GET", "/api/included-usage?days=14")).toMatchObject({ status: 200, body: { usage: null } });
  });

  it("saves the whole grant list, checks it first, and refreshes the report after", async () => {
    joinTrial();
    const call = await serve();
    await call("GET", "/api/owner-usage");
    expect(calls).toHaveLength(1);

    for (const grants of [
      [{ provider: "elevenlabs", usd: 0, since: "2026-10-01" }],
      [{ provider: "elevenlabs", usd: 500, since: "October 1" }],
      [{ provider: "elevenlabs", usd: 500, since: "2026-10-01" }, { provider: "elevenlabs", usd: 20, since: "2026-10-02" }],
      [{ provider: "nobody", usd: 5, since: "2026-10-01" }],
    ]) expect((await call("PUT", "/api/owner-usage/grants", { grants })).status).toBe(422);
    expect(calls).toHaveLength(1);

    const saved = [{ provider: "elevenlabs", usd: 500, since: "2026-10-01", spentMicros: 0 }];
    reply = (_url, init) => init.method === "PUT" ? answer(200, { grants: saved }) : answer(200, { ...REPORT, grants: saved });
    const put = await call("PUT", "/api/owner-usage/grants", { grants: [{ provider: "elevenlabs", usd: 500, since: "2026-10-01" }] });
    expect(put).toMatchObject({ status: 200, body: { grants: saved } });
    expect(calls[1]).toMatchObject({ url: `${API}/usage/owner/grants`, method: "PUT", authorization: `Bearer ${KEY}` });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ grants: [{ provider: "elevenlabs", usd: 500, since: "2026-10-01" }] });

    const after = await call("GET", "/api/owner-usage");
    expect(calls).toHaveLength(3);
    expect(after.body.report).toMatchObject({ grants: saved });
  });

  it("says when the service is down, busy or answers something it cannot read", async () => {
    joinTrial();
    const call = await serve();
    reply = () => { throw new TypeError("fetch failed"); };
    expect((await call("GET", "/api/included-usage?days=1")).status).toBe(503);
    reply = () => answer(429, { error: { code: "rate_limited", message: "Too many requests, try again in a minute." } });
    expect(await call("GET", "/api/included-usage?days=2")).toMatchObject({ status: 429, body: { error: "Too many requests, try again in a minute." } });
    reply = () => answer(500, { error: { code: "internal", message: "boom" } });
    expect((await call("GET", "/api/included-usage?days=3")).status).toBe(502);
    reply = () => answer(200, { owner: "yes" });
    expect((await call("GET", "/api/included-usage?days=4")).status).toBe(502);
    reply = () => answer(422, { error: { code: "invalid_grants", message: "Send the grants again." } });
    expect(await call("PUT", "/api/owner-usage/grants", { grants: [] })).toMatchObject({ status: 422, body: { error: "Send the grants again." } });
  });

  it("only takes the methods it serves", async () => {
    const call = await serve();
    const posted = await call("POST", "/api/included-usage", {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    const read = await call("GET", "/api/owner-usage/grants");
    expect(read.status).toBe(405);
    expect(read.headers.get("allow")).toBe("PUT");
    expect(await call("GET", "/api/included-usage-elsewhere")).toMatchObject({ status: 404, body: { from: "inline routes" } });
  });
});
