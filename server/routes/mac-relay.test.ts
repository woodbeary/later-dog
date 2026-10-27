import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { MacRelayQueue } from "../laterdog/mac-relay.ts";
import type { MacRelayMirrors } from "../laterdog/mac-relay-mirrors.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createMacRelayRoutes, MAC_RELAY_JOB_GONE, MAC_RELAY_NOT_RELAYED, MAC_RELAY_OWNER_ONLY, type MacRelayRouteDeps } from "./mac-relay.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(overrides: Partial<MacRelayRouteDeps> = {}) {
  const mirrors: MacRelayMirrors = {
    isRelayBot: vi.fn((id: string) => id === "relayed"),
    ensure: vi.fn(() => ({ botId: "relayed", created: true })),
  };
  const deps: MacRelayRouteDeps = { cloudHome: true, mayRelay: () => true, queue: new MacRelayQueue(), mirrors, ...overrides };
  const routes = [createMacRelayRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "session", scopes: ["admin"] } as unknown as RequestAuth;
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, deps };
}

const send = (base: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("the Mac relay routes on a Cloud home", () => {
  it("mirrors a local dog, leases its job and carries the reply back", async () => {
    const { base, deps } = await serve();
    const mirrored = await send(base, "PUT", "/api/mac-relay/mirrors/local-1", { name: "Rex", title: "Fixer" });
    expect(await mirrored.json()).toEqual({ botId: "relayed", created: true });
    expect(deps.mirrors.ensure).toHaveBeenCalledWith("local-1", { name: "Rex", title: "Fixer" });
    const reply = deps.queue.requestTurn("relayed", "thread-1", "fix it");
    const { job } = await (await send(base, "GET", "/api/mac-relay/bots/relayed/job")).json() as { job: { id: string } };
    expect(job).toMatchObject({ botId: "relayed", threadId: "thread-1", text: "fix it" });
    expect((await send(base, "GET", "/api/mac-relay/bots/relayed/job").then((r) => r.json() as Promise<{ job: unknown }>)).job).toBeNull();
    expect((await send(base, "POST", `/api/mac-relay/jobs/${job.id}/result`, { text: "fixed" })).status).toBe(200);
    await expect(reply).resolves.toBe("fixed");
    const again = await send(base, "POST", `/api/mac-relay/jobs/${job.id}/result`, { text: "fixed" });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: MAC_RELAY_JOB_GONE });
  });

  it("passes a failure from the Mac to the waiting turn", async () => {
    const { base, deps } = await serve();
    const outcome = deps.queue.requestTurn("relayed", "thread-1", "fix it").then(() => "answered", (error: Error) => error.message);
    const { job } = await (await send(base, "GET", "/api/mac-relay/bots/relayed/job")).json() as { job: { id: string } };
    expect((await send(base, "POST", `/api/mac-relay/jobs/${job.id}/fail`, { message: "the Mac dog stopped" })).status).toBe(200);
    expect(await outcome).toBe("the Mac dog stopped");
  });

  it("refuses anyone but the owner, and dogs that are not relayed", async () => {
    const refused = await serve({ mayRelay: () => false });
    const response = await send(refused.base, "GET", "/api/mac-relay/bots/relayed/job");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: MAC_RELAY_OWNER_ONLY });
    const { base } = await serve();
    const other = await send(base, "GET", "/api/mac-relay/bots/plain/job");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: MAC_RELAY_NOT_RELAYED });
    expect((await send(base, "PUT", "/api/mac-relay/mirrors/local-1", { name: "" })).status).toBe(400);
    expect((await send(base, "PUT", "/api/mac-relay/mirrors/local-1", { name: "Rex", soul: "x" })).status).toBe(400);
  });

  it("stays out of the way on a Mac and for other paths", async () => {
    const { base } = await serve({ cloudHome: false });
    expect(await (await send(base, "GET", "/api/mac-relay/bots/relayed/job")).json()).toEqual({ from: "inline routes" });
    const home = await serve();
    expect(await (await send(home.base, "DELETE", "/api/mac-relay/bots/relayed/job")).json()).toEqual({ from: "inline routes" });
  });
});
