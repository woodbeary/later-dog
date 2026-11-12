import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { StreamWatchClient } from "../stream-watch.ts";
import { createStreamWatchRoutes } from "./stream-watch.ts";
import { PASS, type RouteContext } from "./table.ts";

function ctx(method: string, path: string, body: unknown, sent: unknown[]): RouteContext {
  return {
    req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method,
    auth: { kind: "session", session: { id: "s1" } } as unknown as RouteContext["auth"],
    json: ((_res: unknown, status: number, payload: unknown) => { sent.push([status, payload]); }) as RouteContext["json"],
    readBody: async () => body,
  } as RouteContext;
}

describe("POST /api/events/watch", () => {
  it("narrows the live stream a phone is watching and refuses a stream that is gone", async () => {
    const client: StreamWatchClient = { watchId: "w1", watch: new Set(), sessionId: "s1" };
    const route = createStreamWatchRoutes({ clients: () => [client] });
    const sent: unknown[] = [];
    await route(ctx("POST", "/api/events/watch", { id: "w1", threads: ["t1"] }, sent));
    await route(ctx("POST", "/api/events/watch", { id: "gone", threads: ["t1"] }, sent));
    await route(ctx("POST", "/api/events/watch", {}, sent));
    expect(sent).toEqual([
      [200, { threads: ["t1"] }],
      [404, { error: "that live stream is gone; reconnect and try again" }],
      [400, { error: expect.stringContaining("send { id, threads }") }],
    ]);
    expect(client.watch).toEqual(new Set(["t1"]));
    expect(await route(ctx("GET", "/api/events/watch", {}, sent))).toBe(PASS);
  });
});
