import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BotRecord } from "../store.ts";
import { json, readBody } from "../harness/http.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createNearbyPlacesRoute, NEARBY_PLACES_PATH } from "./nearby-places.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(active: boolean) {
  const routes = [createNearbyPlacesRoute({
    active: () => active,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ lat: 1, lon: 2, tags: { amenity: "cafe", name: "Cup" } }] }) }),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchInternalRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET", json,
      sender: { id: "dog-1", name: "Rex" } as BotRecord, threadId: "thread-1", capability: {}, readBody: () => readBody(req),
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (body: unknown, method = "POST") => {
    const response = await fetch(`${base}${NEARBY_PLACES_PATH}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
}

describe(`POST ${NEARBY_PLACES_PATH}`, () => {
  it("answers a dog in its turn with the places it found", async () => {
    const call = await serve(true);
    const found = await call({ what: "coffee", latitude: 1, longitude: 2 });
    expect(found.status).toBe(200);
    expect(found.body.places).toEqual([expect.objectContaining({ name: "Cup", distance_m: 0 })]);
  });

  it("explains a request it can't search, refuses a turn that ended, and leaves other requests alone", async () => {
    const call = await serve(true);
    expect(await call({ what: "coffee" })).toEqual({ status: 400, body: { error: expect.stringContaining("Say where") } });
    expect(await call({}, "GET")).toEqual({ status: 404, body: { from: "inline routes" } });
    const ended = await serve(false);
    expect(await ended({ what: "coffee", latitude: 1, longitude: 2 })).toEqual({ status: 401, body: { error: "the internal turn capability has expired" } });
  });
});
