import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createStorageRoutes } from "./storage.ts";
import { PASS, type RouteContext } from "./table.ts";

function ctx(method: string, path: string, sent: unknown[]): RouteContext {
  return {
    req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method, auth: {} as RouteContext["auth"],
    json: ((_res: unknown, status: number, body: unknown) => { sent.push([status, body]); }) as RouteContext["json"],
    readBody: async () => ({}),
  } as RouteContext;
}

describe("the storage routes", () => {
  it("report the home's storage and run a cleanup on request", async () => {
    let cleaned = 0;
    const route = createStorageRoutes({ storage: () => ({ low: false }), clean: () => { cleaned++; return { freedBytes: 5 }; }, measure: () => false });
    const sent: unknown[] = [];
    await route(ctx("GET", "/api/storage", sent));
    await route(ctx("POST", "/api/storage/clean", sent));
    expect(sent).toEqual([[200, { low: false }], [200, { run: { freedBytes: 5 }, storage: { low: false } }]]);
    expect(cleaned).toBe(1);
    expect(await route(ctx("GET", "/api/other", sent))).toBe(PASS);
  });

  it("start a measurement and answer at once with whether one started", async () => {
    let going = false;
    const route = createStorageRoutes({ storage: () => ({}), clean: () => null, measure: () => (going ? false : (going = true)) });
    const sent: unknown[] = [];
    await route(ctx("POST", "/api/storage/measure", sent));
    await route(ctx("POST", "/api/storage/measure", sent));
    expect(sent).toEqual([[200, { started: true }], [200, { started: false }]]);
    expect(await route(ctx("GET", "/api/storage/measure", sent))).toBe(PASS);
  });

  it("report and start the read-only plan of which chats' files could move, only when the home has one", async () => {
    let measuring = false;
    const route = createStorageRoutes({ storage: () => ({}), clean: () => null, measure: () => false, awayPlan: { last: () => ({ totals: { folders: 2 } }), measuring: () => measuring, measure: () => (measuring ? false : (measuring = true)) } });
    const sent: unknown[] = [];
    await route(ctx("POST", "/api/storage/away-plan", sent));
    await route(ctx("GET", "/api/storage/away-plan", sent));
    expect(sent).toEqual([[200, { started: true }], [200, { measuring: true, plan: { totals: { folders: 2 } } }]]);
    const without = createStorageRoutes({ storage: () => ({}), clean: () => null, measure: () => false });
    expect(await without(ctx("GET", "/api/storage/away-plan", sent))).toBe(PASS);
  });
});
