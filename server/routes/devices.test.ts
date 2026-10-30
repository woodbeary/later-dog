import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import type { PublicSession } from "../sessions.ts";
import { createDeviceRoutes, deviceLabel } from "./devices.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const PHONE: PublicSession = { id: "s1", label: "Safari on iPhone", scopes: ["admin"], createdAt: 1, lastSeenAt: 2, expiresAt: 3 };

async function serve() {
  const renamed: Array<[string, string]> = [];
  const routes = [createDeviceRoutes({ sessions: { rename: (id, label) => { renamed.push([id, label]); return id === "s1" ? { ...PHONE, label } : null; } } })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as unknown };
  };
  return { call, renamed };
}

describe("renaming a signed-in device", () => {
  it("is for the owner only", () => {
    expect(requiredScope("PATCH", "/api/auth/sessions/s1")).toBe("admin");
  });

  it("keeps a short one-line name", () => {
    expect(deviceLabel("  Jacob's   iPhone ")).toBe("Jacob's iPhone");
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel("x".repeat(61))).toBeNull();
    expect(deviceLabel("two\u2028lines")).toBe("two lines");
    expect(deviceLabel("bell\u0007")).toBeNull();
    expect(deviceLabel(42)).toBeNull();
  });

  it("renames the device it names and says when it is gone", async () => {
    const { call, renamed } = await serve();
    expect(await call("PATCH", "/api/auth/sessions/s1", { label: "Jacob's iPhone" })).toEqual({ status: 200, body: { session: { ...PHONE, label: "Jacob's iPhone" } } });
    expect(await call("PATCH", "/api/auth/sessions/s9", { label: "Old Mac" })).toEqual({ status: 404, body: { error: "That device is no longer signed in." } });
    expect(await call("PATCH", "/api/auth/sessions/s1", { label: " " })).toMatchObject({ status: 400 });
    expect(renamed).toEqual([["s1", "Jacob's iPhone"], ["s9", "Old Mac"]]);
  });

  it("leaves listing and signing out to the server's own routes", async () => {
    const { call } = await serve();
    expect(await call("DELETE", "/api/auth/sessions/s1")).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await call("GET", "/api/auth/sessions")).toEqual({ status: 404, body: { from: "inline routes" } });
  });
});
