import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createPinOrderRoutes, PIN_ORDER_PATH } from "./pin-order.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(pinned: string[]) {
  const asked: string[][] = [];
  const routes = [createPinOrderRoutes({
    order: (ids) => {
      asked.push([...ids]);
      return [...ids.filter((id) => pinned.includes(id)), ...pinned.filter((id) => !ids.includes(id))];
    },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

describe("PUT /api/bots/pin-order", () => {
  it("saves the order of pinned dogs on the home and answers with every pin in its place", async () => {
    const { base, asked } = await serve(["rex", "ivy", "max"]);
    const response = await fetch(`${base}${PIN_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ order: ["max", "rex"] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ order: ["max", "rex", "ivy"] });
    expect(asked).toEqual([["max", "rex"]]);
  });

  it("refuses ids that are not dog ids, other bodies and other methods, and leaves other paths alone", async () => {
    const { base, asked } = await serve(["rex"]);
    expect((await fetch(`${base}${PIN_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ order: ["../rex"] }) })).status).toBe(400);
    expect((await fetch(`${base}${PIN_ORDER_PATH}`, { method: "PUT", body: JSON.stringify({ pins: [] }) })).status).toBe(400);
    expect((await fetch(`${base}${PIN_ORDER_PATH}`)).status).toBe(405);
    expect(await (await fetch(`${base}/api/bots/rex`)).json()).toEqual({ from: "inline routes" });
    expect(asked).toEqual([]);
  });

  it("lets a signed-in phone reorder pins, as it may pin and unpin", () => {
    expect(requiredScope("PUT", PIN_ORDER_PATH)).toBe("client");
    expect(requiredScope("PATCH", "/api/bots/rex")).toBe("client");
  });
});
