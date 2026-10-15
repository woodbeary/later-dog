import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createComputerSharing } from "./computer-sharing.mjs";
import { DROPPED_POLL_RETRY_MS, droppedPollRetryMs } from "./lending-poll.mjs";

const ORIGIN = "https://laterdog-u-fixture.fly.dev";
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };

const reply = (value, status = 200, headers = {}) => ({
  ok: status < 400, status, headers: { get: name => headers[name.toLowerCase()] ?? null },
  body: (async function* () { yield Buffer.from(JSON.stringify(value)); })(),
});

function myCloud() {
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), connects: 0, polls: 0, results: [], queue: [], drop: [] };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/auth/session") return reply({ kind: "session", id: state.sessionId, scopes: ["admin", "client"], cloudHome: true });
    if (route === "/.well-known/laterdog/environment") return reply({ environmentId: state.environmentId, capabilities: { sharedComputers: true } });
    if (route === "/api/shared-computers/connect") { state.connects++; state.computerId = body.id; return reply({ ok: true }); }
    if (route.endsWith("/poll")) {
      state.polls++;
      const drop = state.drop.shift();
      if (drop === "closed") return reply({ error: "Container port connection closed unexpectedly" }, 500);
      if (drop === "lost") throw new TypeError("fetch failed");
      await delay(20);
      init?.signal?.throwIfAborted();
      return reply({ job: state.queue.shift() ?? null });
    }
    if (route.endsWith("/lease")) return reply({ active: true });
    if (route.endsWith("/result")) { state.results.push(body.result); return reply({ ok: true }); }
    if (route.endsWith("/disconnect")) return reply({ ok: true });
    throw new Error(`no route ${route}`);
  };
  return state;
}

async function lending(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "laterdog-lending-poll-")));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = path.join(dir, "home");
  await mkdir(home);
  await writeFile(path.join(home, "plan.md"), "from the Mac");
  const server = myCloud();
  const states = [];
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: (...args) => server.fetch(...args), environments: () => [env],
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home, computerName: () => "Jo's MacBook Air",
    cuaConnection: async () => null, retryMs: 5_000,
    onChange: () => states.push(sharing.cloudState(env).connected === true),
  });
  t.after(() => sharing.close());
  sharing.start({ maintainer: false });
  return { server, sharing, states };
}

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

test("a poll My Cloud dropped is asked again at once, without reconnecting or showing the Mac as gone", async t => {
  const { server, sharing, states } = await lending(t);
  await until(() => sharing.cloudState(env).connected && server.polls > 0, "the first poll");
  const polls = server.polls;
  const seen = states.length;
  server.drop.push("closed", "lost");
  await until(() => server.polls >= polls + 3, "two dropped polls and a good one", 3000);
  server.queue.push({ id: randomUUID(), operation: { computer_id: server.computerId, action: "run_command", command: "cat plan.md" } });
  const started = Date.now();
  await until(() => server.results.length === 1, "the command's result", 3000);
  assert.ok(Date.now() - started < 2000, "the work arrives in seconds, not after a reconnect back-off");
  assert.deepEqual(JSON.parse(server.results[0].content[0].text), { exitCode: 0, output: "from the Mac" });
  assert.equal(server.connects, 1, "a dropped poll is not a disconnect");
  assert.equal(states.slice(seen).includes(false), false, "the Mac never shows as disconnected");
});

test("only a dropped or failed poll is retried quickly, a few times, and never a refusal or a resting home", () => {
  const gone = new AbortController(); gone.abort();
  assert.equal(droppedPollRetryMs(Object.assign(new Error("Server request failed (500)."), { status: 500 }), 0), DROPPED_POLL_RETRY_MS[0]);
  assert.equal(droppedPollRetryMs(new TypeError("fetch failed"), 1), DROPPED_POLL_RETRY_MS[1]);
  assert.equal(droppedPollRetryMs(new TypeError("fetch failed"), DROPPED_POLL_RETRY_MS.length), null);
  assert.equal(droppedPollRetryMs(new TypeError("fetch failed"), 0, gone.signal), null);
  assert.equal(droppedPollRetryMs(Object.assign(new Error("Pair this desktop again"), { status: 403 }), 0), null);
  assert.equal(droppedPollRetryMs(Object.assign(new Error("My Cloud is resting."), { status: 503, home: "asleep" }), 0), null);
  assert.ok(DROPPED_POLL_RETRY_MS.reduce((sum, ms) => sum + ms, 0) <= 5000);
});
