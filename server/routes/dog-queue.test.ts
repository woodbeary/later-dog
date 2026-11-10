import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { safeStopWords, stoppedByLine } from "../laterdog/safe-stop.ts";
import type { RoomHandoff } from "../room-handoffs.ts";
import type { BotRecord } from "../store.ts";
import { createDogQueueRoute, DOG_QUEUE_PATH, queueText } from "./dog-queue.ts";
import { dispatchInternalRoutes } from "./internal.ts";

const dog = (id: string, name: string): BotRecord => ({ id, name, threadId: `${id}-chat` }) as BotRecord;
const CLOVER = dog("clover", "Clover");
const PATCH = dog("patch", "Patch");
const TASK = dog("task", "task");
const request = (id: string, from: string, status: RoomHandoff["status"], text: string): RoomHandoff & { from: string } =>
  ({ id, rootId: `${from}-root`, parentId: `${from}-root`, threadId: "patch-chat", botId: "patch", key: id, text, createdAt: 1, status,
    result: "", reported: false, executions: 0, approvalGranted: false, kind: "work", from }) as RoomHandoff & { from: string };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(sender: BotRecord, options: { owner?: boolean } = {}) {
  const nodes = [request("r-run", "clover", "running", "Fix the fallback"), request("r-q1", "clover", "queued", "Ship the phone update"),
    request("r-q2", "task", "queued", "Check the storage")];
  const calls: string[] = [];
  const route = createDogQueueRoute({
    active: () => true,
    ownerActing: () => options.owner !== false,
    mainBotId: () => "clover",
    dogs: () => [CLOVER, PATCH, TASK],
    queueOf: () => nodes.filter((n) => ["running", "queued"].includes(n.status)),
    senderOf: (n) => (n as RoomHandoff & { from: string }).from,
    node: (id) => nodes.find((n) => n.id === id),
    personQueue: () => [],
    busyThreads: () => ["patch-chat"],
    cancel: (id, reason) => {
      calls.push(`cancel ${id}: ${reason}`);
      const n = nodes.find((each) => each.id === id)!;
      n.status = "cancelled";
      return n;
    },
    replace: (id, text) => {
      calls.push(`replace ${id}: ${text}`);
      const old = nodes.find((each) => each.id === id)!;
      old.status = "cancelled";
      const fresh = { ...old, id: `${id}-new`, text, status: "queued" as const };
      nodes.splice(nodes.indexOf(old), 0, fresh);
      return fresh;
    },
    stop: async ({ dog: target, threadId, by, force }) => {
      calls.push(`stop ${target.id} ${threadId} by ${by.id}${force ? " now" : ""}`);
      return force ? "stopped" : "safe";
    },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender, threadId: `${sender.id}-chat`, capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${DOG_QUEUE_PATH}`;
  const call = async (body: Record<string, unknown>) => {
    const answer = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as { text?: string; error?: string; outcome?: string; requestId?: string } };
  };
  return { call, calls, nodes };
}

describe("seeing a dog's queue", () => {
  it("shows the running request and the queued ones, with ids and senders", async () => {
    const { call } = await serve(CLOVER);
    const { status, body } = await call({ dog: "patch" });
    expect(status).toBe(200);
    expect(body.text).toContain("Patch [id: patch] is working in 1 chat.");
    expect(body.text).toContain("Running:\n- [requestId: r-run] from Clover: Fix the fallback");
    expect(body.text).toContain("- [requestId: r-q1] from Clover: Ship the phone update\n- [requestId: r-q2] from task: Check the storage");
  });
});

describe("stopping a dog for the owner", () => {
  it("lets the main dog stop another dog at a safe point, or at once with force", async () => {
    const { call, calls } = await serve(CLOVER);
    expect((await call({ dog: "Patch", action: "stop" })).body.outcome).toBe("safe");
    expect((await call({ dog: "Patch", action: "stop", force: true })).body.outcome).toBe("stopped");
    expect(calls).toEqual(["stop patch patch-chat by clover", "stop patch patch-chat by clover now"]);
  });

  it("lets another of the owner's dogs stop only work it sent", async () => {
    const { call, calls } = await serve(TASK);
    const refused = await call({ dog: "patch", action: "stop" });
    expect(refused.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses anyone not acting for the owner in the owner's home", async () => {
    const { call, calls } = await serve(CLOVER, { owner: false });
    expect((await call({ dog: "patch", action: "stop" })).status).toBe(403);
    expect((await call({ dog: "patch" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("tells the stopped dog to finish or roll back an atomic step first, and names who stopped it in its chat", () => {
    expect(safeStopWords("Clover")).toContain("publishing an app update, a merge, a push, a deploy or a migration, finish it or roll it back first");
    expect(stoppedByLine("Clover", "Jacob")).toBe("Stopped by Clover for Jacob");
    expect(stoppedByLine("Clover", undefined, "scope changed")).toBe("Stopped by Clover for the owner: scope changed");
  });
});

describe("cancelling or replacing one queued request", () => {
  it("cancels one request by id and leaves the rest of the queue", async () => {
    const { call, calls, nodes } = await serve(CLOVER);
    const { status, body } = await call({ action: "cancel", requestId: "r-q2" });
    expect(status).toBe(200);
    expect(calls).toEqual(["cancel r-q2: Clover cancelled this request for the owner before it started."]);
    expect(nodes.find((n) => n.id === "r-q1")?.status).toBe("queued");
    expect(body.text).toContain("task is told");
  });

  it("lets a dog cancel or replace its own request but not another dog's", async () => {
    const { call, calls } = await serve(TASK);
    expect((await call({ action: "cancel", requestId: "r-q1" })).status).toBe(403);
    expect((await call({ action: "cancel", requestId: "r-q2" })).status).toBe(200);
    expect(calls).toEqual(["cancel r-q2: task cancelled this request for the owner before it started."]);
  });

  it("replaces a queued request in one step", async () => {
    const { call, calls } = await serve(CLOVER);
    const { status, body } = await call({ action: "replace", requestId: "r-q1", message: "Ship only the usage ring fix" });
    expect(status).toBe(200);
    expect(body.requestId).toBe("r-q1-new");
    expect(calls).toEqual(["replace r-q1: Ship only the usage ring fix"]);
    expect(body.text).toContain("- [requestId: r-q1-new] from Clover: Ship only the usage ring fix");
  });

  it("asks for the pieces it needs instead of guessing", async () => {
    const { call } = await serve(CLOVER);
    expect((await call({ action: "replace", requestId: "r-q1" })).status).toBe(400);
    expect((await call({ action: "cancel", dog: "patch" })).status).toBe(400);
    expect((await call({ action: "cancel", requestId: "missing" })).status).toBe(404);
  });
});

it("lists card waits under Needs you instead of completed or queued work", () => {
  const text = queueText(PATCH, [request("r-card", "clover", "needs-you", "Sign in")], [], [], () => "Clover", () => "clover");
  expect(text).toContain("Needs you:\n- [requestId: r-card]");
  expect(text).toContain("Queued teammate requests: none.");
});
