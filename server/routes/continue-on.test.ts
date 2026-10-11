import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createContinueOnRoutes, type ContinueOnRouteDeps } from "./continue-on.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const task = { id: "scout", threadId: "t-2", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };

async function serve(overrides: Partial<ContinueOnRouteDeps> = {}) {
  const deps: ContinueOnRouteDeps = {
    task: vi.fn(() => task),
    refusal: vi.fn(() => null),
    continueOn: vi.fn(() => ({ status: 200 as const, body: { continued: true } })),
    ...overrides,
  };
  const routes = [createContinueOnRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, deps };
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("continue on another account", () => {
  it("continues the named thread on the chosen account", async () => {
    const { base, deps } = await serve();
    const response = await post(base, "/api/bots/scout/continue-on", { threadId: "t-2", instanceId: "claude-two" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ continued: true });
    expect(deps.task).toHaveBeenCalledWith("scout", "t-2");
    expect(deps.continueOn).toHaveBeenCalledWith(task, "claude-two");
  });

  it("answers with the refusal the account check gives", async () => {
    const { base } = await serve({ continueOn: () => ({ status: 409, body: { error: "That's the account that ran out." } }) });
    const response = await post(base, "/api/bots/scout/continue-on", { threadId: "t-2", instanceId: "claude" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "That's the account that ran out." });
  });

  it("needs the thread, and continues nothing without it", async () => {
    const { base, deps } = await serve();
    const response = await post(base, "/api/bots/scout/continue-on", { instanceId: "claude-two" });
    expect(response.status).toBe(400);
    expect(deps.task).not.toHaveBeenCalled();
    expect(deps.continueOn).not.toHaveBeenCalled();
  });

  it("refuses a thread that isn't the caller's", async () => {
    const { base, deps } = await serve({ refusal: () => "Only its owner can do that." });
    const response = await post(base, "/api/bots/scout/continue-on", { threadId: "t-2", instanceId: "claude-two" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only its owner can do that." });
    expect(deps.continueOn).not.toHaveBeenCalled();
  });

  it("leaves other requests to the rest of the server", async () => {
    const { base, deps } = await serve();
    expect((await fetch(`${base}/api/bots/scout/continue-on`)).status).toBe(404);
    expect((await post(base, "/api/bots/scout/continue", { threadId: "t-2" })).status).toBe(404);
    expect(deps.task).not.toHaveBeenCalled();
  });
});
