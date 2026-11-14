import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ContextBreakdown } from "../../shared/context-breakdown.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { createChatContextRoutes } from "./chat-context.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const COUNTED = {
  at: 1_700_000_000_000,
  source: "engine",
  total: 30_000,
  window: 200_000,
  compactsAt: 167_000,
  parts: [
    { id: "conversation", tokens: 20_000, name: "Messages", files: ["/home/person/CLAUDE.md"] },
    { id: "tools", tokens: 10_000, tools: ["mcp__agents__private_tool"] },
    { id: "free", tokens: 170_000 },
    { id: "tools", tokens: 40_000, deferred: true },
  ],
  memoryFiles: [{ path: "/home/person/CLAUDE.md" }],
} as unknown as ContextBreakdown;

async function serve(chats: Record<string, ContextBreakdown | null>) {
  const routes = [createChatContextRoutes({ breakdown: (threadId) => (threadId in chats ? Promise.resolve(chats[threadId]!) : undefined) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, method = "GET") => {
    const response = await fetch(`${base}${path}`, { method });
    return { status: response.status, text: await response.text() };
  };
}

describe("GET /api/threads/:id/context", () => {
  it("can be read by exactly the sessions that can read the conversation's other views", () => {
    expect(requiredScope("GET", "/api/threads/thread-1/context")).toBe(requiredScope("GET", "/api/threads/thread-1/screen-goals"));
    expect(requiredScope("GET", "/api/threads/thread-1/context")).toBe(requiredScope("GET", "/api/threads/thread-1/messages"));
    expect(serviceAllowed("GET", "/api/threads/thread-1/context")).toBe(serviceAllowed("GET", "/api/threads/thread-1/screen-goals"));
    expect(requiredScope("POST", "/api/threads/thread-1/context")).toBe("admin");
  });

  it("answers with sizes only", async () => {
    const get = await serve({ "thread-1": COUNTED });
    const answer = await get("/api/threads/thread-1/context");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      at: 1_700_000_000_000,
      source: "engine",
      total: 30_000,
      window: 200_000,
      compactsAt: 167_000,
      parts: [
        { id: "conversation", tokens: 20_000 },
        { id: "tools", tokens: 10_000 },
        { id: "free", tokens: 170_000 },
        { id: "tools", tokens: 40_000, deferred: true },
      ],
    });
    for (const leak of ["CLAUDE.md", "/home/person", "private_tool", "Messages", "memoryFiles"]) expect(answer.text).not.toContain(leak);
  });

  it("says 404 when there is nothing yet, and when the chat is not a dog's", async () => {
    const get = await serve({ "thread-1": null });
    const nothing = await get("/api/threads/thread-1/context");
    expect([nothing.status, JSON.parse(nothing.text)]).toEqual([404, { error: "nothing yet" }]);
    const ghost = await get("/api/threads/ghost/context");
    expect([ghost.status, JSON.parse(ghost.text)]).toEqual([404, { error: "no such conversation" }]);
  });

  it("leaves other methods and paths to the rest of the home", async () => {
    const get = await serve({ "thread-1": COUNTED });
    expect((await get("/api/threads/thread-1/context", "POST")).text).toContain("inline routes");
    expect((await get("/api/threads/thread-1/context/extra")).text).toContain("inline routes");
  });
});
