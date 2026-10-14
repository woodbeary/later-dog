import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { createDecider, deciderReady } from "../decider/index.ts";
import { json, readBody } from "../harness/http.ts";
import { TYPING_RANK_JOB, rankCandidates } from "../laterdog/typing-rank.ts";
import { createTypingService } from "../laterdog/typing-suggestions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import { createTypingSuggestionsRoutes } from "./typing-suggestions.ts";
import { dispatchRoutes } from "./table.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function serve(cfg: AppConfig, fetcher: typeof fetch) {
  const typing = createTypingService({ config: () => cfg, fetch: fetcher });
  const decider = createDecider({ config: () => cfg, fetch: fetcher });
  const routes = [createTypingSuggestionsRoutes({
    typing,
    rankingReady: () => deciderReady(cfg, TYPING_RANK_JOB),
    rank: (input, signal) => rankCandidates(decider, input, signal),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
  };
}

const own: AppConfig = { typing: { accountId: ACCOUNT, token: "cf-token" } };

describe("POST /api/typing/complete", () => {
  it("answers with the completion, never caching it in the browser", async () => {
    const fetcher = vi.fn(async () => reply({ result: { response: " the failing tests" } }));
    const post = await serve(own, fetcher as unknown as typeof fetch);
    const answer = await post("/api/typing/complete", { prefix: "Please fix", dog: "Rex", messages: [{ role: "dog", text: "Two tests fail." }] });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.body).toMatchObject({ completion: " the failing tests", source: "cloudflare" });
  });

  it("answers an empty completion with the reason when there is nothing to show", async () => {
    const post = await serve({ features: { typingSuggestions: false } }, vi.fn() as unknown as typeof fetch);
    expect((await post("/api/typing/complete", { prefix: "Please fix" })).body).toEqual({ completion: "", reason: "off" });
    const none = await serve({}, vi.fn() as unknown as typeof fetch);
    expect((await none("/api/typing/complete", { prefix: "Please fix" })).body).toEqual({ completion: "", reason: "no-service" });
  });

  it("refuses a body that is not a typing request", async () => {
    const post = await serve(own, vi.fn() as unknown as typeof fetch);
    expect((await post("/api/typing/complete", { prefix: "" })).status).toBe(400);
    expect((await post("/api/typing/complete", { prefix: "a", messages: [{ role: "x", text: "y" }] })).status).toBe(400);
  });

  it("leaves other paths and methods alone", async () => {
    const post = await serve(own, vi.fn() as unknown as typeof fetch);
    expect((await post("/api/typing/complete", undefined, "GET")).status).toBe(404);
    expect((await post("/api/typing/other", {})).status).toBe(404);
  });
});

describe("POST /api/typing/rank", () => {
  const withJev: AppConfig = { ...own, decider: { enabled: true, key: "tsk_unit_key_0123456789abcdef" } };

  it("asks the decision model to pick one of the person's phrases", async () => {
    const fetcher = vi.fn(async () => reply({ model: "clef", answers: { answer: { type: "choice", choice: "c1", probabilities: { c0: 0.1, c1: 0.9 } } } }));
    const post = await serve(withJev, fetcher as unknown as typeof fetch);
    const answer = await post("/api/typing/rank", { typed: "Can you", lastMessage: "Two tests fail.", candidates: ["Can you check the build", "Can you fix the failing tests"] });
    expect(answer.body).toMatchObject({ index: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the decision model is not set up", async () => {
    const fetcher = vi.fn();
    const post = await serve(own, fetcher as unknown as typeof fetch);
    expect((await post("/api/typing/rank", { typed: "x", candidates: ["a b", "c d"] })).body).toEqual({ index: null, reason: "off" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses candidates that are not text", async () => {
    const post = await serve(withJev, vi.fn() as unknown as typeof fetch);
    expect((await post("/api/typing/rank", { candidates: [1, 2] })).status).toBe(400);
    expect((await post("/api/typing/rank", {})).status).toBe(400);
  });
});

describe("POST /api/typing/test", () => {
  it("checks a draft account without saving it", async () => {
    const fetcher = vi.fn(async () => reply({ result: { response: "ok" } }));
    const post = await serve({}, fetcher as unknown as typeof fetch);
    expect((await post("/api/typing/test", { accountId: ACCOUNT, token: "draft" })).body).toMatchObject({ ok: true });
    expect((await post("/api/typing/test", {})).body).toEqual({ ok: false, reason: "no-service" });
  });
});

describe("who may call it", () => {
  it("lets a paired device ask for a completion or a ranking, but only the owner check a Cloudflare account", () => {
    expect(requiredScope("POST", "/api/typing/complete")).toBe("client");
    expect(requiredScope("POST", "/api/typing/rank")).toBe("client");
    expect(requiredScope("POST", "/api/typing/test")).toBe("admin");
  });
});
