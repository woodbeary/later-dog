import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLaterDogRoutes } from "./laterdog.ts";
import { PASS } from "./table.ts";

const servers: Server[] = [];
const saved = { url: process.env.LATERDOG_SUPERVISOR_URL, token: process.env.LATERDOG_TOKEN };
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved.url === undefined) delete process.env.LATERDOG_SUPERVISOR_URL; else process.env.LATERDOG_SUPERVISOR_URL = saved.url;
  if (saved.token === undefined) delete process.env.LATERDOG_TOKEN; else process.env.LATERDOG_TOKEN = saved.token;
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const seen: { method: string; url: string; authorization?: string; body: string }[] = [];
  const supervisor = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    });
  }));
  process.env.LATERDOG_SUPERVISOR_URL = supervisor;
  process.env.LATERDOG_TOKEN = "desktop-token";
  const route = createLaterDogRoutes();
  const desktop = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody }).then((answer) => {
      if (answer === PASS) { res.writeHead(404); res.end(); }
    });
  }));
  return { seen, desktop };
}

describe("the desktop's later.dog proxy", () => {
  it("forwards the cloud task reads with only their own query, and the screen request", async () => {
    const { seen, desktop } = await fixture();
    const id = "6a1f8f2e-1111-4222-8333-944444444444";
    expect((await fetch(`${desktop}/api/laterdog/jobs?ids=${id}&bot=dog-1&limit=8&secret=x`)).status).toBe(200);
    expect((await fetch(`${desktop}/api/laterdog/jobs/${id}/activity?after=120&other=1`)).status).toBe(200);
    expect((await fetch(`${desktop}/api/laterdog/jobs/${id}/screen`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect((await fetch(`${desktop}/api/laterdog/workspace?ids=${id}`)).status).toBe(200);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /v1/jobs?ids=${id}&bot=dog-1&limit=8`,
      `GET /v1/jobs/${id}/activity?after=120`,
      `POST /v1/jobs/${id}/screen`,
      "GET /v1/workspace",
    ]);
    expect(seen.every((request) => request.authorization === "Bearer desktop-token")).toBe(true);
  });

  it("refuses routes outside the workspace's own", async () => {
    const { seen, desktop } = await fixture();
    expect((await fetch(`${desktop}/api/laterdog/jobs/x/delete`)).status).toBe(404);
    expect((await fetch(`${desktop}/api/laterdog/wakeups/pull`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(seen).toEqual([]);
  });
});
