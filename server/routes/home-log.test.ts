import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeLogRoutes } from "./home-log.ts";
import { PASS, type RouteContext } from "./table.ts";

type Sent = { status: number; body: unknown; headers?: Record<string, string> };

function ctx(path: string, auth: RouteContext["auth"], sent: Sent[], method = "GET"): RouteContext {
  const res = {
    writeHead(status: number, headers: Record<string, string>) { sent.push({ status, body: "", headers }); return res; },
    end(text: string) { sent.at(-1)!.body = text; },
  };
  const url = new URL(`http://x${path}`);
  return {
    req: {} as IncomingMessage, res: res as unknown as ServerResponse, url, path: url.pathname, method, auth,
    json: ((_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); }) as RouteContext["json"],
    readBody: async () => ({}),
  } as RouteContext;
}

const owner = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: {} } as unknown as RouteContext["auth"];
const guest = { kind: "session", via: "bearer", scopes: ["client"], session: {} } as unknown as RouteContext["auth"];
const dogTools = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: {}, localTools: true } as unknown as RouteContext["auth"];
const service = { kind: "loopback", scopes: ["client"], trust: "service" } as unknown as RouteContext["auth"];

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the home log route", () => {
  it("gives the owner the newest lines as plain text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "home-log-route-"));
    made.push(dir);
    writeFileSync(join(dir, "server-1.log"), "2026-11-25T10:00:00.000Z one\n2026-11-25T10:01:00.000Z two\n");
    const route = createHomeLogRoutes({ dir: () => dir });
    const sent: Sent[] = [];
    await route(ctx("/api/home-log?lines=1", owner, sent));
    expect(sent).toEqual([{ status: 200, body: "2026-11-25T10:01:00.000Z two\n", headers: expect.objectContaining({ "content-type": "text/plain; charset=utf-8" }) }]);
  });

  it("refuses guests, a dog's own calls and local services", async () => {
    const route = createHomeLogRoutes({ dir: () => "/nowhere" });
    const sent: Sent[] = [];
    for (const auth of [guest, dogTools, service]) await route(ctx("/api/home-log", auth, sent));
    expect(sent.map((entry) => entry.status)).toEqual([403, 403, 403]);
  });

  it("is not there on a computer that is not a Cloud home", async () => {
    const route = createHomeLogRoutes({ dir: () => null });
    const sent: Sent[] = [];
    await route(ctx("/api/home-log", owner, sent));
    expect(sent[0]!.status).toBe(404);
  });

  it("checks the query and passes other paths on", async () => {
    const route = createHomeLogRoutes({ dir: () => "/nowhere" });
    const sent: Sent[] = [];
    await route(ctx("/api/home-log?lines=nope", owner, sent));
    await route(ctx("/api/home-log", owner, sent, "POST"));
    expect(sent.map((entry) => entry.status)).toEqual([400, 405]);
    expect(await route(ctx("/api/storage", owner, sent))).toBe(PASS);
  });
});
