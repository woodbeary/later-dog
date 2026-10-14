import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createHandoffContinueRoutes, type HandoffContinueRouteDeps } from "./handoff-continue.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const root = { id: "h-1", threadId: "t-1", parentId: null };

async function serve(overrides: Partial<HandoffContinueRouteDeps> = {}) {
  const deps: HandoffContinueRouteDeps = {
    root: vi.fn((id: string) => (id === root.id ? root : undefined)),
    refusal: vi.fn(() => null),
    continueTree: vi.fn(() => ({ resent: 2 })),
    markContinuing: vi.fn(),
    ...overrides,
  };
  const routes = [createHandoffContinueRoutes(deps)];
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

const post = (base: string, path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("continue handed-off work", () => {
  it("continues the tree and turns the offer into a continuing line", async () => {
    const { base, deps } = await serve();
    const response = await post(base, "/api/handoffs/h-1/continue");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resent: 2 });
    expect(deps.continueTree).toHaveBeenCalledWith("h-1");
    expect(deps.markContinuing).toHaveBeenCalledWith("t-1", "h-1");
  });

  it("knows only the top of a tree", async () => {
    const { base, deps } = await serve({ root: () => ({ id: "h-2", threadId: "t-1", parentId: "h-1" }) });
    expect((await post(base, "/api/handoffs/h-2/continue")).status).toBe(404);
    expect((await post(base, "/api/handoffs/missing/continue")).status).toBe(404);
    expect(deps.continueTree).not.toHaveBeenCalled();
  });

  it("refuses work in a thread the caller may not touch", async () => {
    const { base, deps } = await serve({ refusal: () => "that chat belongs to another account" });
    const response = await post(base, "/api/handoffs/h-1/continue");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "that chat belongs to another account" });
    expect(deps.continueTree).not.toHaveBeenCalled();
  });

  it("says why when the work cannot continue", async () => {
    const { base, deps } = await serve({ continueTree: () => { throw new Error("nothing left to continue"); } });
    const response = await post(base, "/api/handoffs/h-1/continue");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "nothing left to continue" });
    expect(deps.markContinuing).not.toHaveBeenCalled();
  });

  it("leaves other paths and methods to the rest of the server", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/handoffs/h-1/continue`)).json()).toEqual({ from: "inline routes" });
    expect(await (await post(base, "/api/handoffs/h-1/stop")).json()).toEqual({ from: "inline routes" });
  });
});
