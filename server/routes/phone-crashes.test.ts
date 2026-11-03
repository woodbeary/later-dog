import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { PhoneCrashes } from "../laterdog/phone-crashes.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createPhoneCrashRoutes, PHONE_CRASHES_PATH } from "./phone-crashes.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve() {
  const crashes = new PhoneCrashes(join(mkdtempSync(join(tmpdir(), "phone-crash-route-")), "phone-crashes.json"));
  const logged: string[] = [];
  const routes = [createPhoneCrashRoutes({ crashes, log: (line) => logged.push(line) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "session", scopes: ["admin"] } as unknown as RequestAuth;
    if (await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PHONE_CRASHES_PATH}`;
  const post = (body: unknown) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, logged };
}

describe("the phone's crash route", () => {
  it("keeps a report, logs one line for it and lists it back", async () => {
    const { base, post, logged } = await serve();
    expect((await post({ kind: "ended", at: 13_000, startedAt: 1_000, build: "9" })).status).toBe(201);
    expect(logged).toEqual(["phone crash report: the app ended without closing after 12 s (build 9)"]);
    const listed = await (await fetch(base)).json() as { reports: unknown[] };
    expect(listed.reports).toHaveLength(1);
  });

  it("refuses anything that is not a crash report and leaves other paths alone", async () => {
    const { base, post, logged } = await serve();
    expect((await post({ kind: "ended" })).status).toBe(400);
    expect((await fetch(base, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(base.replace("crashes", "elsewhere"))).status).toBe(404);
    expect(logged).toEqual([]);
  });
});
