import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createDogActivityRoutes } from "./dog-activity.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const NOW = Date.parse("2026-10-30T20:00:00Z");

async function serve() {
  const asked: Array<[string, number]> = [];
  const routes = [createDogActivityRoutes({
    threads: (botId) => (botId === "dog-1" ? [[{ role: "user", kind: "text", at: NOW - 60_000 }, { role: "bot", kind: "text", at: NOW }]] : null),
    turnTimes: (botId, since) => { asked.push([botId, since]); return [NOW]; },
    now: () => NOW,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { get: async (path: string) => { const response = await fetch(`${base}${path}`); return { status: response.status, body: await response.json() as any }; }, asked };
}

describe("GET /api/bots/:id/activity", () => {
  it("is for the owner only", () => {
    expect(requiredScope("GET", "/api/bots/dog-1/activity")).toBe("admin");
  });

  it("answers a dog's days, reading turns from just before the window", async () => {
    const { get, asked } = await serve();
    const answer = await get("/api/bots/dog-1/activity?days=7");
    expect(answer.status).toBe(200);
    expect(answer.body.days).toHaveLength(7);
    expect(answer.body.totals).toEqual({ sent: 1, replies: 1, turns: 1, workedSeconds: 60 });
    expect(asked).toEqual([["dog-1", NOW - 8 * 86_400_000]]);
  });

  it("keeps the window between 1 and 30 days and knows when a dog is gone", async () => {
    const { get } = await serve();
    expect((await get("/api/bots/dog-1/activity?days=400")).body.days).toHaveLength(30);
    expect((await get("/api/bots/dog-1/activity")).body.days).toHaveLength(30);
    expect(await get("/api/bots/ghost/activity")).toEqual({ status: 404, body: { error: "no such bot" } });
  });
});
