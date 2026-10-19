import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { busyRefusal, createComputerChangeRoutes, heldRefusal, ONLY_LATERDOG_COMPUTERS, type ComputerChangeRouteDeps } from "./computer-change.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(overrides: Partial<ComputerChangeRouteDeps> = {}) {
  const release = vi.fn();
  const deps: ComputerChangeRouteDeps = {
    bot: vi.fn((id: string) => (id === "rex" ? { id: "rex", name: "Rex" } : undefined)),
    busy: vi.fn(() => false),
    controlHeld: vi.fn(() => false),
    claim: vi.fn(() => release),
    change: vi.fn(async () => ({ state: "starting" })),
    ...overrides,
  };
  const routes = [createComputerChangeRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, deps, release };
}

const post = (base: string, path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("resetting or updating a dog's cloud computer", () => {
  it("resets and updates under the computer's lifecycle claim", async () => {
    const { base, deps, release } = await serve();
    for (const action of ["reset", "update"] as const) {
      const response = await post(base, `/api/bots/rex/computer/${action}`);
      expect(response.status, action).toBe(200);
      expect(await response.json()).toEqual({ state: "starting" });
      expect(deps.change).toHaveBeenLastCalledWith(action, "rex");
    }
    expect(deps.claim).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("refuses while the dog is working, and changes nothing", async () => {
    const { base, deps } = await serve({ busy: vi.fn(() => true) });
    const response = await post(base, "/api/bots/rex/computer/reset");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: busyRefusal("Rex") });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.change).not.toHaveBeenCalled();
  });

  it("refuses while the person has control of the computer", async () => {
    const { base, deps } = await serve({ controlHeld: vi.fn(() => true) });
    const response = await post(base, "/api/bots/rex/computer/update");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: heldRefusal("Rex") });
    expect(deps.change).not.toHaveBeenCalled();
  });

  it("refuses a computer that is already being changed, and a VPS computer", async () => {
    const claimed = await serve({ claim: vi.fn(() => { throw Object.assign(new Error("this bot's cloud computer is being changed — wait for it to finish"), { status: 409 }); }) });
    const response = await post(claimed.base, "/api/bots/rex/computer/reset");
    expect(response.status).toBe(409);
    expect(claimed.deps.change).not.toHaveBeenCalled();

    const vps = await serve({ bot: vi.fn(() => ({ id: "rex", name: "Rex", cloudBackend: "vps" })) });
    const refused = await post(vps.base, "/api/bots/rex/computer/update");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: ONLY_LATERDOG_COMPUTERS });
  });

  it("releases the claim when the change fails", async () => {
    const { base, release } = await serve({ change: vi.fn(async () => { throw Object.assign(new Error("Its files are larger than 1 GB"), { status: 413 }); }) });
    const response = await post(base, "/api/bots/rex/computer/update");
    expect(response.status).toBe(413);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("answers only its own paths, for an existing dog, as JSON", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/bots/rex/computer/reset`)).status).toBe(404);
    expect((await post(base, "/api/bots/rex/computer/reboot")).status).toBe(404);
    expect((await post(base, "/api/bots/ghost/computer/reset")).status).toBe(404);
    expect((await fetch(`${base}/api/bots/rex/computer/reset`, { method: "POST", body: "{}" })).status).toBe(415);
  });
});
