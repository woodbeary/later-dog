import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MacRelayQueue } from "../server/laterdog/mac-relay.ts";
import { macRelayRoutes } from "../server/laterdog/mac-relay-routes.ts";
import { relayOneJob, runRelayLoop } from "./dev-home-relay.mjs";

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function startHomeFixture(queue, token) {
  const routes = macRelayRoutes(queue, (bearer) => (bearer === token ? { botId: "bot-1" } : null));
  const server = http.createServer(async (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const url = new URL(req.url, "http://localhost");
    let result;
    if (req.method === "GET" && url.pathname === "/api/internal/mac-relay/jobs") result = await routes.nextJob(bearer);
    else if (req.method === "POST" && url.pathname.endsWith("/result")) result = await routes.completeJob(bearer, url.pathname.split("/").at(-2), await readJsonBody(req));
    else if (req.method === "POST" && url.pathname.endsWith("/fail")) result = await routes.failJob(bearer, url.pathname.split("/").at(-2), await readJsonBody(req));
    else result = { status: 404, body: { error: "not found" } };
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function startLocalFixture({ reply, failWith } = {}) {
  let busy = true;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/bots/local-dog/messages") {
      await readJsonBody(req);
      busy = true;
      setTimeout(() => (busy = false), 20);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && url.pathname === "/api/bots") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ bots: [{ id: "local-dog", busy }] }));
    }
    if (req.method === "GET" && url.pathname === "/api/threads/thread-1/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      if (failWith) return res.end(JSON.stringify({ messages: [] }));
      return res.end(JSON.stringify({ messages: [{ role: "bot", text: reply ?? "done" }] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("dev-home-relay", () => {
  let dir;
  let sessionFile;
  const token = "laterdog_sess_fixturetoken123";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-mac-relay-"));
    sessionFile = join(dir, "my-home.session.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("carries a phone-posted nudge from the home queue to the local dog and the reply back", async () => {
    const queue = new MacRelayQueue();
    const home = await startHomeFixture(queue, token);
    const local = await startLocalFixture({ reply: "fixed it on the Mac" });

    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug, please");
    const picked = await relayOneJob({
      home: { url: new URL(`http://127.0.0.1:${home.address().port}`), token },
      localUrl: `http://127.0.0.1:${local.address().port}`,
      localBotId: "local-dog",
      log: () => {},
    });

    expect(picked).toBe(true);
    await expect(turn).resolves.toBe("fixed it on the Mac");
    await new Promise((resolve) => home.close(resolve));
    await new Promise((resolve) => local.close(resolve));
  });

  it("reports nothing to relay when the queue is empty", async () => {
    const queue = new MacRelayQueue();
    const home = await startHomeFixture(queue, token);
    const picked = await relayOneJob({
      home: { url: new URL(`http://127.0.0.1:${home.address().port}`), token },
      localUrl: "http://127.0.0.1:1",
      localBotId: "local-dog",
      log: () => {},
    });
    expect(picked).toBe(false);
    await new Promise((resolve) => home.close(resolve));
  });

  it("tells the home the Mac failed the turn when the local dog never replies", async () => {
    const queue = new MacRelayQueue();
    const home = await startHomeFixture(queue, token);
    const local = await startLocalFixture({ failWith: true });
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    turn.catch(() => {});

    const picked = await relayOneJob({
      home: { url: new URL(`http://127.0.0.1:${home.address().port}`), token },
      localUrl: `http://127.0.0.1:${local.address().port}`,
      localBotId: "local-dog",
      log: () => {},
      localPoll: { deadline: Date.now() + 50, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) },
    });
    expect(picked).toBe(true);
    await expect(turn).rejects.toThrow();
    await new Promise((resolve) => home.close(resolve));
    await new Promise((resolve) => local.close(resolve));
  }, 10_000);

  it("runs the loop end to end from a saved session file until the signal aborts", async () => {
    const queue = new MacRelayQueue();
    const home = await startHomeFixture(queue, token);
    const local = await startLocalFixture({ reply: "looped reply" });
    writeFileSync(sessionFile, JSON.stringify({ url: `http://127.0.0.1:${home.address().port}`, token }), { mode: 0o600 });

    const controller = new AbortController();
    const turn = queue.requestTurn("bot-1", "thread-1", "nudge from the phone");
    const loop = runRelayLoop({
      session: sessionFile,
      localUrl: `http://127.0.0.1:${local.address().port}`,
      localBotId: "local-dog",
      signal: controller.signal,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      log: () => {},
    });

    await expect(turn).resolves.toBe("looped reply");
    controller.abort();
    await loop.catch(() => {});
    await new Promise((resolve) => home.close(resolve));
    await new Promise((resolve) => local.close(resolve));
  });
});
