import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createCloudTrialRoutes } from "./cloud-trial.ts";
import { dispatchRoutes } from "./table.ts";

const API = "https://trial.example.test/v1";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const servers: Server[] = [];
let home: string;
let claimed: Set<string>;
let down: boolean;
let others: boolean;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "laterdog-trial-route-"));
  vi.stubEnv("LATERDOG_HOME", home);
  vi.stubEnv("LATERDOG_COMPUTERS_API", "");
  vi.stubEnv("LATERDOG_TRIAL_API", API);
  claimed = new Set();
  down = false;
  others = false;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const service = (async (input: string | URL | Request, init: RequestInit = {}) => {
  if (down) throw new TypeError("fetch failed");
  const url = new URL(String(input));
  if (url.pathname === "/v1/trials") return answer(200, { offered: true, minutes: 30, days: 7 });
  const key = /^Bearer (\S+)$/.exec(new Headers(init.headers).get("authorization") ?? "")?.[1] ?? "";
  if (!claimed.has(sha256(key))) return answer(401, { error: { code: "unauthorized", message: "This free trial has ended or has not started yet." } });
  if (init.method === "DELETE") return answer(200, { ended: true });
  return answer(200, { trial: { state: "active", minutes: 30, minutesLeft: 12, expiresAt: "2026-10-17T12:00:00.000Z" } });
}) as typeof fetch;

async function serve() {
  const changed = vi.fn();
  const routes = [createCloudTrialRoutes({ otherComputers: () => others, changed, fetch: service })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { thrown: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path = "/api/computers/trial") => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" } });
    return { status: response.status, headers: response.headers, body: (await response.json()) as { url: string } };
  };
  return { call, changed };
}

describe("the free trial route", () => {
  it("offers, starts and confirms a trial, and tells every window once it is in use", async () => {
    const { call, changed } = await serve();
    const offered = await call("GET");
    expect(offered).toMatchObject({ status: 200, body: { state: "offered", minutes: 30, days: 7 } });
    expect(offered.headers.get("cache-control")).toBe("private, no-store");

    const started = await call("POST");
    expect(started).toMatchObject({ status: 200, body: { state: "pending", url: expect.stringMatching(/^https:\/\/trial\.example\.test\/trial\?claim=[a-f0-9]{64}$/) } });
    expect(await call("GET")).toMatchObject({ body: { state: "pending" } });
    expect(changed).not.toHaveBeenCalled();

    claimed.add(new URL(started.body.url).searchParams.get("claim")!);
    expect(await call("GET")).toEqual(expect.objectContaining({ status: 200, body: { state: "active", minutes: 30, minutesLeft: 12, expiresAt: "2026-10-17T12:00:00.000Z" } }));
    expect(changed).toHaveBeenCalledTimes(1);
    await call("GET");
    expect(changed).toHaveBeenCalledTimes(1);

    expect(await call("DELETE")).toMatchObject({ status: 200, body: { state: "ended" } });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("answers a refusal with its status and an unreachable service with 503", async () => {
    const { call, changed } = await serve();
    others = true;
    expect(await call("POST")).toMatchObject({ status: 409, body: { error: "Cloud computers are already set up here" } });
    others = false;
    const started = await call("POST");
    claimed.add(new URL(started.body.url).searchParams.get("claim")!);
    await call("GET");
    down = true;
    expect(await call("DELETE")).toMatchObject({ status: 503, body: { error: expect.stringMatching(/could not be reached/) } });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("allows only its own methods, and leaves other paths alone", async () => {
    const { call } = await serve();
    const put = await call("PUT");
    expect(put).toMatchObject({ status: 405, body: { error: "method not allowed" } });
    expect(put.headers.get("allow")).toBe("GET, POST, DELETE");
    expect(await call("GET", "/api/computers/trials")).toMatchObject({ status: 404, body: { from: "inline routes" } });
    expect(await call("GET", "/api/computers/trial/extra")).toMatchObject({ status: 404, body: { from: "inline routes" } });
  });
});
