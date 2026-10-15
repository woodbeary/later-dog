import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAutoMove } from "./cloud-auto-move.mjs";
import { createMacHold } from "./cloud-hold.mjs";
import { createCloudWindow, windowChoice } from "./cloud-window.mjs";

const HOME = "https://home.fixture.test";
const connected = (machine = { status: "ready", origin: HOME }, id = "acct") => ({ status: "connected", account: { id, email: "a@b.test" }, machine });
const SIGNED_OUT = { status: "signed-out" };
const LOCAL = { bots: 6, rooms: 0, chats: 12, bytes: 1000, files: 3 };
const STARTER = { bots: 1, rooms: 0, chats: 0, bytes: 10, files: 0 };

function mac({ local = LOCAL, saved = null, homeHasTestDogs = true, otherMacMoved = false, moveFails = null, routines = ["nightly", "weekly"] } = {}) {
  const log = { window: [], moves: [], hold: [], logs: [], failures: [], timers: [] };
  const store = { raw: saved };
  const dogs = { routines: Object.fromEntries(routines.map(id => [id, true])), held: false, paused: [] };
  const home = { workspace: homeHasTestDogs ? "test-dogs" : "empty", previousKept: false, routines: {} };
  const move = {
    running: () => false,
    estimate: async () => local,
    move: async (destination, flags) => {
      const { onPacked, ...rest } = flags;
      log.moves.push({ destination: destination.origin, ...rest });
      if (otherMacMoved && flags.yieldToOtherComputer) return { phase: "failed", action: "move", error: { code: "other_computer_moved", message: "x" } };
      const packed = { ...dogs.routines };
      await onPacked();
      if (moveFails) return { phase: "failed", action: "move", error: { code: moveFails, message: "The home did not answer." } };
      home.previousKept = home.workspace !== "empty";
      home.workspace = "mac-dogs";
      home.routines = packed;
      return { phase: "done", action: "move", moved: { bots: local.bots, rooms: local.rooms, chats: local.chats }, stayedOnMac: [{ name: "task-workspaces", bytes: 5 }] };
    },
  };
  const serverHold = createMacHold({
    request: async (_route, init) => {
      const { held } = JSON.parse(init.body);
      log.hold.push(held);
      if (held) { dogs.held = true; dogs.paused = Object.keys(dogs.routines).filter(id => dogs.routines[id]); for (const id of dogs.paused) dogs.routines[id] = false; }
      else { dogs.held = false; for (const id of dogs.paused) dogs.routines[id] = true; dogs.paused = []; }
      return new Response("{}", { status: 200 });
    },
  });
  const autoMove = createCloudAutoMove({ move, read: () => store.raw, write: contents => { store.raw = contents; }, now: () => 1, log: line => log.logs.push(line),
    pause: held => serverHold.set(held), onFailed: reason => log.failures.push(reason) });
  const window = createCloudWindow({
    autoMove, hold: serverHold,
    setTimer: (run, ms) => { const timer = { run, ms }; log.timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    destinationFor: choice => ({ id: "cloud", name: "My Cloud", origin: choice.origin, kind: "cloud", grant: async () => ({}) }),
    showHome: destination => log.window.push(`home ${destination.origin}`),
    showLocal: () => log.window.push("local"),
    log: line => log.logs.push(line),
  });
  return { window, log, dogs, home, store };
}

test("signed out, the window stays on the local server and nothing is held", async () => {
  const m = mac();
  assert.deepEqual(await m.window.sync(SIGNED_OUT), { kind: "local", signedOut: true });
  assert.deepEqual(m.log.window, []);
  assert.deepEqual(m.log.moves, []);
  assert.equal(m.dogs.held, false);
});

test("while the home is waking, the window stays local and shows the waking screen choice", async () => {
  assert.deepEqual(windowChoice({ state: connected({ status: "provisioning" }), autoMove: "pending" }), { kind: "local", screen: "waking", accountId: "acct" });
  assert.deepEqual(windowChoice({ state: connected({ status: "stopped" }), autoMove: "pending" }), { kind: "local", screen: "waking", accountId: "acct" });
  assert.deepEqual(windowChoice({ state: connected(), autoMove: "moving" }), { kind: "local", screen: "moving", accountId: "acct" });
  assert.deepEqual(windowChoice({ state: connected(), autoMove: "failed" }), { kind: "local", screen: null, accountId: "acct" });
  assert.deepEqual(windowChoice({ state: { status: "signed-out", message: "restoring" }, autoMove: "pending" }), { kind: "keep", signedOut: false });
  assert.deepEqual(windowChoice({ state: connected(), autoMove: "pending" }), { kind: "cloud", origin: HOME, accountId: "acct" });
  const m = mac();
  await m.window.sync(connected({ status: "provisioning" }));
  assert.deepEqual(m.log.moves, []);
  assert.deepEqual(m.log.window, []);
});

test("first sign-in moves the Mac's dogs over a home holding test dogs, keeps the home's previous workspace, then shows the home", async () => {
  const m = mac();
  const result = await m.window.sync(connected());
  assert.equal(result.kind, "cloud");
  assert.deepEqual(m.log.moves, [{ destination: HOME, requireEmpty: false, verifyArrival: true, profile: "cloud-move", yieldToOtherComputer: true }]);
  assert.equal(m.home.workspace, "mac-dogs");
  assert.equal(m.home.previousKept, true);
  assert.deepEqual(m.log.window, [`home ${HOME}`]);
});

test("after the move the Cloud runs the routines that were on and the Mac pauses all of its own; signing out resumes them on the Mac", async () => {
  const m = mac();
  await m.window.sync(connected());
  assert.deepEqual(m.home.routines, { nightly: true, weekly: true });
  assert.equal(m.dogs.held, true);
  assert.deepEqual(m.dogs.routines, { nightly: false, weekly: false });
  await m.window.sync(SIGNED_OUT);
  assert.equal(m.dogs.held, false);
  assert.deepEqual(m.dogs.routines, { nightly: true, weekly: true });
  assert.deepEqual(m.log.hold, [true, false]);
});

test("a repeat sign-in on the same Mac does not move again, shows the home and holds the Mac's dogs again", async () => {
  const m = mac();
  await m.window.sync(connected());
  await m.window.sync(SIGNED_OUT);
  const again = await m.window.sync(connected());
  assert.equal(again.kind, "cloud");
  assert.equal(m.log.moves.length, 1);
  assert.equal(m.dogs.held, true);
});

test("account refreshes while signed in do not move again, hold again or reload the window controller's decision", async () => {
  const m = mac();
  for (let i = 0; i < 4; i++) await m.window.sync(connected());
  assert.equal(m.log.moves.length, 1);
  assert.deepEqual(m.log.hold, [true]);
});

test("a second Mac with its own dogs shows the home without replacing it, leaves its data and routines untouched and logs one line", async () => {
  const m = mac({ otherMacMoved: true, homeHasTestDogs: false });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.move], ["cloud", "joined"]);
  assert.equal(m.home.workspace, "empty", "the home is not replaced");
  assert.deepEqual(m.log.window, [`home ${HOME}`]);
  assert.equal(m.dogs.held, false);
  assert.deepEqual(m.dogs.routines, { nightly: true, weekly: true });
  assert.equal(m.log.logs.filter(line => /another computer already moved/.test(line)).length, 1);
  await m.window.sync(connected());
  assert.equal(m.log.moves.length, 1);
});

test("a failed move keeps the local workspace on screen, lets the Mac's dogs work again, and tries again on its own a little later", async () => {
  const m = mac({ moveFails: "network" });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.screen], ["local", null]);
  assert.deepEqual(m.log.window, ["local"]);
  assert.equal(m.log.failures.length, 1);
  assert.deepEqual(m.log.hold, [true, false], "the Mac's dogs wait during the copy and work again once it fails");
  assert.equal(m.dogs.held, false);
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000]);
  await m.window.sync(connected());
  assert.equal(m.log.moves.length, 1, "an account refresh does not start another copy");
  await m.log.timers[0].run();
  assert.equal(m.log.moves.length, 2, "the scheduled retry copies again");
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000, 60_000]);
  await m.window.sync(SIGNED_OUT);
  assert.equal(m.log.timers[1].cleared, true, "signing out drops the pending retry");
  const relaunched = mac({ saved: m.store.raw });
  assert.equal((await relaunched.window.sync(connected())).kind, "cloud");
});

test("a copy that succeeds keeps the Mac's dogs paused from the start of the copy and opens My Cloud", async () => {
  const m = mac();
  assert.equal((await m.window.sync(connected())).kind, "cloud");
  assert.deepEqual(m.log.hold, [true]);
  assert.equal(m.dogs.held, true);
  assert.deepEqual(m.log.timers, []);
});

test("a Mac with only the starter dog just shows the home and does not hold", async () => {
  const m = mac({ local: STARTER });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.move], ["cloud", "nothing"]);
  assert.equal(m.log.moves.length, 0);
  assert.equal(m.dogs.held, false);
});
