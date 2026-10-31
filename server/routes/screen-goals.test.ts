import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ScreenGoalMessage } from "../../shared/screen-goals.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createScreenGoalRoutes } from "./screen-goals.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function longThread(): ScreenGoalMessage[] {
  const messages: ScreenGoalMessage[] = [
    { id: "ask-old", role: "user", kind: "text", text: "Post the launch note on X", at: 1 },
    { id: "look", role: "bot", kind: "activity", at: 2, tool: { name: "mcp__computer__screenshot", ok: true } },
    { id: "open", role: "bot", kind: "activity", at: 3, tool: { name: "mcp__computer__open_url", ok: true, input: { url: "https://x.com/compose" } } },
  ];
  for (let at = 10; at < 400; at += 1) messages.push({ id: `chat-${at}`, role: "bot", kind: "text", text: "Working on it", at });
  messages.push({ id: "ask-new", role: "user", kind: "text", text: "Thanks", at: 500 });
  return messages;
}

async function serve() {
  const routes = [createScreenGoalRoutes({ dogThread: (threadId) => (threadId === "thread-1" ? longThread() : null) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string) => { const response = await fetch(`${base}${path}`); return { status: response.status, body: await response.json() as any }; };
}

describe("GET /api/threads/:id/screen-goals", () => {
  it("can be read by every session that can read the conversation", () => {
    expect(requiredScope("GET", "/api/threads/thread-1/screen-goals")).toBe(requiredScope("GET", "/api/threads/thread-1/messages"));
  });

  it("finds goals from the whole conversation, however far back they are", async () => {
    const get = await serve();
    const answer = await get("/api/threads/thread-1/screen-goals");
    expect(answer.status).toBe(200);
    expect(answer.body.goals).toEqual([{
      id: "ask-old",
      text: "Post the launch note on X",
      at: 1,
      latest: false,
      steps: [{ id: "look", at: 2, action: "look", ok: true }, { id: "open", at: 3, action: "open", detail: "x.com", ok: true }],
    }]);
  });

  it("knows when a conversation isn't a dog's", async () => {
    const get = await serve();
    expect(await get("/api/threads/ghost/screen-goals")).toEqual({ status: 404, body: { error: "no such conversation" } });
    expect((await get("/api/threads/thread-1/screen-goals/extra")).body).toEqual({ from: "inline routes" });
  });
});
