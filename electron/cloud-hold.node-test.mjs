import assert from "node:assert/strict";
import test from "node:test";
import { createMacHold } from "./cloud-hold.mjs";

function fixture({ up = true } = {}) {
  const calls = [], logs = [];
  const state = { up };
  const hold = createMacHold({
    request: async (route, init) => {
      if (!state.up) throw new Error("server down");
      calls.push([route, JSON.parse(init.body)]);
      return new Response("{}", { status: 200 });
    },
    log: line => logs.push(line),
  });
  return { hold, calls, logs, state };
}

test("holding and releasing the Mac's dogs go to the local server once each", async () => {
  const { hold, calls } = fixture();
  await hold.set(true);
  await hold.set(true);
  assert.equal(hold.held(), true);
  await hold.set(false);
  assert.equal(hold.held(), false);
  assert.deepEqual(calls, [["/api/cloud-hold", { held: true }], ["/api/cloud-hold", { held: false }]]);
});

test("a hold asked for while the Mac's server is down is applied when it comes up", async () => {
  const { hold, calls, logs, state } = fixture({ up: false });
  await hold.set(true);
  assert.equal(hold.held(), false);
  assert.equal(logs.length, 1);
  state.up = true;
  await hold.flush();
  assert.equal(hold.held(), true);
  assert.deepEqual(calls, [["/api/cloud-hold", { held: true }]]);
});

function retrying({ failFor = 0, retryMs = [10, 20] } = {}) {
  const calls = [], logs = [], timers = [];
  let failing = failFor;
  const hold = createMacHold({
    request: async (route, init) => {
      calls.push(JSON.parse(init.body).held);
      if (failing > 0) { failing--; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }
      return new Response("{}", { status: 200 });
    },
    log: line => logs.push(line),
    retryMs,
    setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); },
  });
  return { hold, calls, logs, timers };
}

test("a pause that could not reach the Mac's server is tried again by itself until it applies, and says why it failed", async () => {
  const { hold, calls, logs, timers } = retrying({ failFor: 2 });
  await hold.set(true);
  assert.equal(hold.held(), false);
  assert.deepEqual(timers.map(timer => timer.ms), [10]);
  assert.match(logs[0], /did not apply yet \(fetch failed: ECONNREFUSED\); trying again in 0 s/);
  timers.shift().run();
  await until(() => calls.length === 2);
  assert.deepEqual(timers.map(timer => timer.ms), [20]);
  timers.shift().run();
  await until(() => hold.held());
  assert.deepEqual(calls, [true, true, true]);
  assert.match(logs.at(-1), /pausing this Mac's dogs applied on try 3/);
  assert.equal(timers.length, 0);
});

test("retries stop after the last wait, and start over when the wish changes", async () => {
  const { hold, calls, timers } = retrying({ failFor: 10, retryMs: [10] });
  await hold.set(true);
  timers.shift().run();
  await until(() => calls.length === 2);
  assert.equal(timers.length, 0, "no endless retry loop");
  await hold.set(false);
  assert.deepEqual(timers.map(timer => timer.ms), [10]);
  hold.close();
  assert.equal(timers.length, 0);
});

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("timed out");
}
