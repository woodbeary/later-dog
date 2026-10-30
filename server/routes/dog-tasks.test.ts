import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { START_TASKS_PATH, TASK_IN_TASK } from "../laterdog/dog-tasks.ts";
import type { BotRecord } from "../store.ts";
import { createDogTaskRoute } from "./dog-tasks.ts";
import { dispatchInternalRoutes } from "./internal.ts";

const SENDER = { id: "dog-olive", name: "Olive" } as BotRecord;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(options: { active?: boolean; insideTask?: boolean; full?: boolean } = {}) {
  const started: { threadId: string; instruction: string }[] = [];
  const route = createDogTaskRoute({
    active: () => options.active ?? true,
    insideTask: () => options.insideTask ?? false,
    starter: (sender, threadId) => ({
      open: (title) => (options.full ? "task-full" : `${sender.id}:${threadId}:${title}`),
      run: async (taskThreadId, instruction) => {
        if (options.full) throw new Error("this dog has reached its limit of 10 parallel threads — wait for one to finish");
        started.push({ threadId: taskThreadId, instruction });
      },
    }),
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender: SENDER, threadId: "main", capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, path = START_TASKS_PATH) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { post, started };
}

describe("the route a dog uses to start tasks", () => {
  it("starts each task in a new conversation of the calling dog and tells the dog what started", async () => {
    const { post, started } = await serve();
    const answer = await post({ tasks: [{ title: "Flights", instruction: "Find flights to Tokyo." }] });
    expect(answer.status).toBe(200);
    expect(started).toEqual([{ threadId: "dog-olive:main:Flights", instruction: "Find flights to Tokyo." }]);
    expect(answer.body.text).toContain("Started a task: “Flights”.");
  });

  it("refuses a bad request, an expired turn, a task starting more tasks, and says when nothing started", async () => {
    expect((await (await serve()).post({ tasks: [] })).status).toBe(400);
    expect((await (await serve({ active: false })).post({ tasks: [{ title: "a", instruction: "b" }] })).status).toBe(401);
    const inside = await (await serve({ insideTask: true })).post({ tasks: [{ title: "a", instruction: "b" }] });
    expect(inside).toEqual({ status: 409, body: { error: TASK_IN_TASK } });
    const full = await (await serve({ full: true })).post({ tasks: [{ title: "a", instruction: "b" }] });
    expect(full.status).toBe(409);
    expect(full.body.text).toContain("Couldn't start “a”: this dog has reached its limit of 10 parallel threads");
  });

  it("leaves other internal paths to other routes", async () => {
    expect((await (await serve()).post({}, "/api/internal/phone/read")).body).toEqual({ from: "inline routes" });
  });
});
