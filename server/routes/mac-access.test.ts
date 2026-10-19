import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createMacAccessRoutes, MAC_ACCESS_HELP, MAC_ACCESS_OWNER_ONLY, type MacAccessRouteDeps } from "./mac-access.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(overrides: Partial<MacAccessRouteDeps> = {}) {
  const deps: MacAccessRouteDeps = {
    cloudHome: true,
    mayChange: vi.fn(() => true),
    update: vi.fn(() => true),
    view: vi.fn(() => ({ mode: "always", macs: [{ id: "mac-1", name: "Jo's MacBook Air", mode: "ask" }] })),
    ...overrides,
  };
  const routes = [createMacAccessRoutes(deps)];
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

const put = (base: string, body: unknown) => fetch(`${base}/api/mac-access`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("who may use the person's Mac, from a Cloud home", () => {
  it("shows the current choice", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/api/mac-access`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "always", macs: [{ id: "mac-1", name: "Jo's MacBook Air", mode: "ask" }] });
  });

  it("saves a valid change and shows the result", async () => {
    const { base, deps } = await serve();
    const response = await put(base, { computers: { "mac-1": "never" } });
    expect(response.status).toBe(200);
    expect(deps.update).toHaveBeenCalledWith({ computers: { "mac-1": "never" } });
  });

  it("lets only the owner change it", async () => {
    const { base, deps } = await serve({ mayChange: vi.fn(() => false) });
    const response = await put(base, { computers: { "mac-1": "always" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: MAC_ACCESS_OWNER_ONLY });
    expect(deps.update).not.toHaveBeenCalled();
    expect((await fetch(`${base}/api/mac-access`)).status).toBe(200);
  });

  it("says what it needs when the change is not valid", async () => {
    const { base, deps } = await serve({ update: vi.fn(() => false) });
    const response = await put(base, { mode: "sometimes" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MAC_ACCESS_HELP });
    expect(deps.view).not.toHaveBeenCalled();
  });

  it("is not there outside a Cloud home, or for other methods", async () => {
    const { base } = await serve({ cloudHome: false });
    expect(await (await fetch(`${base}/api/mac-access`)).json()).toEqual({ from: "inline routes" });
    const cloud = await serve();
    expect(await (await fetch(`${cloud.base}/api/mac-access`, { method: "DELETE" })).json()).toEqual({ from: "inline routes" });
  });
});
