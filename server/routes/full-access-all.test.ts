import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createFullAccessAllRoutes, FULL_ACCESS_ALL_HELP, FULL_ACCESS_ALL_OWNER_ONLY, type FullAccessAllRouteDeps } from "./full-access-all.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(overrides: Partial<FullAccessAllRouteDeps> = {}) {
  const deps: FullAccessAllRouteDeps = {
    cloudHome: true,
    mayChange: vi.fn(() => true),
    update: vi.fn(() => true),
    view: vi.fn(() => ({ enabled: true, dogs: 3, full: 2 })),
    ...overrides,
  };
  const routes = [createFullAccessAllRoutes(deps)];
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

const put = (base: string, body: unknown) => fetch(`${base}/api/full-access-all`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("giving all the owner's dogs Full access, from a Cloud home", () => {
  it("shows whether the switch is on", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/api/full-access-all`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, dogs: 3, full: 2 });
  });

  it("saves a valid change and shows the result", async () => {
    const { base, deps } = await serve();
    const response = await put(base, { enabled: false });
    expect(response.status).toBe(200);
    expect(deps.update).toHaveBeenCalledWith({ enabled: false });
  });

  it("lets only the owner change it", async () => {
    const { base, deps } = await serve({ mayChange: vi.fn(() => false) });
    const response = await put(base, { enabled: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: FULL_ACCESS_ALL_OWNER_ONLY });
    expect(deps.update).not.toHaveBeenCalled();
    expect((await fetch(`${base}/api/full-access-all`)).status).toBe(200);
  });

  it("says what it needs when the change is not valid", async () => {
    const { base, deps } = await serve({ update: vi.fn(() => false) });
    const response = await put(base, { enabled: "sometimes" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: FULL_ACCESS_ALL_HELP });
    expect(deps.view).not.toHaveBeenCalled();
  });

  it("is not there outside a Cloud home, or for other methods", async () => {
    const { base } = await serve({ cloudHome: false });
    expect(await (await fetch(`${base}/api/full-access-all`)).json()).toEqual({ from: "inline routes" });
    const cloud = await serve();
    expect(await (await fetch(`${cloud.base}/api/full-access-all`, { method: "DELETE" })).json()).toEqual({ from: "inline routes" });
  });
});
