import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createAlwaysAllowedRoutes } from "./always-allowed.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function serve(auth: RequestAuth = OWNER) {
  const items = new Map([["scout", ["search:one", "key:b2xk"]]]);
  const resumed: string[] = [];
  const routes = [createAlwaysAllowedRoutes({
    dog: (id) => (items.has(id) ? { id } : undefined),
    mayManage: (who) => who === OWNER,
    list: (id) => ({ paused: !resumed.includes(id), items: (items.get(id) ?? []).map((item) => ({ id: item })) }),
    resume: (id) => { resumed.push(id); },
    remove: (id, itemId) => {
      const kept = (items.get(id) ?? []).filter((item) => item !== itemId);
      if (kept.length === (items.get(id) ?? []).length) return false;
      items.set(id, kept);
      return true;
    },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string) => {
    const response = await fetch(`${base}${path}`, { method });
    return { status: response.status, body: await response.json() };
  };
  return { call, resumed };
}

describe("what a dog may always do, over HTTP", () => {
  it("lists a dog's Always items for the owner", async () => {
    const { call } = await serve();
    expect(await call("GET", "/api/bots/scout/always-allowed")).toEqual({ status: 200, body: { paused: true, items: [{ id: "search:one" }, { id: "key:b2xk" }] } });
  });

  it("removes one item by its id, decoded from the path, and says when there is nothing like it", async () => {
    const { call } = await serve();
    expect(await call("DELETE", `/api/bots/scout/always-allowed/${encodeURIComponent("search:one")}`)).toEqual({ status: 200, body: { paused: true, items: [{ id: "key:b2xk" }] } });
    expect(await call("DELETE", `/api/bots/scout/always-allowed/${encodeURIComponent("search:one")}`)).toEqual({ status: 404, body: { error: "nothing like that is always allowed" } });
  });

  it("resumes a paused list and answers with the list as it is then", async () => {
    const { call, resumed } = await serve();
    expect(await call("POST", "/api/bots/scout/always-allowed/resume")).toMatchObject({ status: 200, body: { paused: false } });
    expect(resumed).toEqual(["scout"]);
  });

  it("refuses anyone who is not the owner or an admin before it reads or changes anything", async () => {
    const { call, resumed } = await serve({ kind: "loopback", scopes: ["client"] });
    for (const [method, path] of [["GET", "/api/bots/scout/always-allowed"], ["POST", "/api/bots/scout/always-allowed/resume"], ["DELETE", "/api/bots/scout/always-allowed/search%3Aone"]] as const) {
      expect((await call(method, path)).status, `${method} ${path}`).toBe(403);
    }
    expect(resumed).toEqual([]);
  });

  it("answers 404 for a dog that does not exist and 405 for anything else on the path, and leaves other paths alone", async () => {
    const { call } = await serve();
    expect(await call("GET", "/api/bots/nobody/always-allowed")).toEqual({ status: 404, body: { error: "no such dog" } });
    expect((await call("PUT", "/api/bots/scout/always-allowed")).status).toBe(405);
    expect((await call("POST", "/api/bots/scout/always-allowed")).status).toBe(405);
    expect(await call("GET", "/api/bots/scout/always-allow")).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await call("GET", "/api/bots/scout/always-allowed/a/b")).toEqual({ status: 404, body: { from: "inline routes" } });
  });
});
