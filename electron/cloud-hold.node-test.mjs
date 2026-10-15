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
