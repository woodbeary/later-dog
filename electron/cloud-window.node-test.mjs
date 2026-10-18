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
  const control = { moveFails };
  const move = {
    running: () => false,
    estimate: async () => local,
    move: async (destination, flags) => {
      const { onPacked, ...rest } = flags;
      log.moves.push({ destination: destination.origin, ...rest });
      if (otherMacMoved && flags.yieldToOtherComputer) return { phase: "failed", action: "move", error: { code: "other_computer_moved", message: "x" } };
      const notEmpty = { phase: "failed", action: "move", error: { code: "not_empty", message: "My Cloud already has bots or chats of its own, so nothing was copied." } };
      if (flags.requireEmpty && home.workspace !== "empty") return notEmpty;
      const packed = { ...dogs.routines };
      await onPacked();
      control.duringCopy?.(home);
      if (flags.requireEmpty && home.workspace !== "empty") return notEmpty;
      if (control.moveFails) return { phase: "failed", action: "move", error: { code: control.moveFails, message: "The home did not answer." } };
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
    log: line => log.logs.push(line),
  });
  return { window, log, dogs, home, store, control };
}

test("signed out, the window stays on the local server and nothing is held", async () => {
  const m = mac();
  assert.deepEqual(await m.window.sync(SIGNED_OUT), { kind: "local", signedOut: true });
  assert.deepEqual(m.log.window, []);
  assert.deepEqual(m.log.moves, []);
  assert.equal(m.dogs.held, false);
});

test("while the home is waking or the first copy runs, the window stays where it is and never picks this Mac's dogs", async () => {
  assert.deepEqual(windowChoice({ state: connected({ status: "provisioning" }), autoMove: "pending" }), { kind: "keep" });
  assert.deepEqual(windowChoice({ state: connected({ status: "stopped" }), autoMove: "pending" }), { kind: "keep" });
  assert.deepEqual(windowChoice({ state: connected(), autoMove: "moving" }), { kind: "keep" });
  assert.deepEqual(windowChoice({ state: { status: "signed-out", message: "restoring" }, autoMove: "pending" }), { kind: "keep" });
  assert.deepEqual(windowChoice({ state: { status: "unavailable", account: { id: "acct" } }, autoMove: "pending" }), { kind: "keep" });
  for (const state of [connected({ status: "provisioning" }), connected({ status: "stopped" }), connected({ status: "failed" }), connected({ status: "ready" }), { status: "unavailable", account: { id: "acct" } }]) {
    for (const autoMove of ["pending", "moving"]) assert.notEqual(windowChoice({ state, autoMove }).kind, "local", "only a real sign-out shows this Mac's page");
  }
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
  assert.deepEqual(m.log.moves, [{ destination: HOME, requireEmpty: false, verifyArrival: true, profile: "cloud-move", yieldToOtherComputer: true, fresh: true }]);
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
  assert.deepEqual(m.log.hold, [false, true, false], "any pause left by a quit is lifted before packing, held after the move, released on sign-out");
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
  assert.deepEqual(m.log.hold, [false, true]);
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

test("a failed copy still shows the home, lets the Mac's dogs work again, and tries the copy again on its own a little later", async () => {
  const m = mac({ moveFails: "network", homeHasTestDogs: false });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.origin, result.move], ["cloud", HOME, "failed"]);
  assert.deepEqual(m.log.window, [`home ${HOME}`]);
  assert.equal(m.log.window.includes("local"), false);
  assert.equal(m.log.failures.length, 1);
  assert.deepEqual(m.log.hold, [false, true, false], "the Mac's dogs wait during the copy and work again once it fails");
  assert.equal(m.dogs.held, false);
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000]);
  assert.equal((await m.window.sync(connected())).kind, "cloud", "an account refresh keeps the home");
  assert.equal(m.log.moves.length, 1, "an account refresh does not start another copy");
  await m.log.timers[0].run();
  assert.equal(m.log.moves.length, 2, "the scheduled retry copies again");
  assert.deepEqual(m.log.moves.map(entry => entry.requireEmpty), [false, true], "once the home is on screen, a copy only goes into a home that is still empty");
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000, 60_000]);
  await m.window.sync(SIGNED_OUT);
  assert.equal(m.log.timers[1].cleared, true, "signing out drops the pending retry");
  const relaunched = mac({ saved: m.store.raw });
  assert.equal((await relaunched.window.sync(connected())).kind, "cloud");
});

test("a copy that succeeds keeps the Mac's dogs paused from the start of the copy and opens My Cloud", async () => {
  const m = mac();
  assert.equal((await m.window.sync(connected())).kind, "cloud");
  assert.deepEqual(m.log.hold, [false, true]);
  assert.equal(m.dogs.held, true);
  assert.deepEqual(m.log.timers, []);
});

test("signing out during the copy releases the Mac once it ends and never opens My Cloud for a signed-out person", async () => {
  const m = mac();
  const copying = m.window.sync(connected());
  await m.window.sync(SIGNED_OUT);
  await copying;
  assert.deepEqual(m.log.window, []);
  assert.equal(m.dogs.held, false);
});

test("a retry that finds My Cloud still waking tries again a minute later, and closing the app drops it", async () => {
  const m = mac({ moveFails: "network" });
  await m.window.sync(connected());
  await m.window.sync(connected({ status: "provisioning" }));
  await m.log.timers[0].run();
  assert.equal(m.log.moves.length, 1);
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000, 60_000]);
  m.window.close();
  assert.equal(m.log.timers[1].cleared, true);
});

test("a Mac with only the starter dog just shows the home and does not hold", async () => {
  const m = mac({ local: STARTER });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.move], ["cloud", "nothing"]);
  assert.equal(m.log.moves.length, 0);
  assert.equal(m.dogs.held, false);
});

test("a copy that can never finish keeps showing the home and does not schedule another copy", async () => {
  const m = mac({ moveFails: "too_large" });
  const result = await m.window.sync(connected());
  assert.deepEqual([result.kind, result.move], ["cloud", "failed"]);
  assert.deepEqual(m.log.window, [`home ${HOME}`]);
  assert.deepEqual(m.log.timers, []);
  assert.equal(m.dogs.held, false);
});

test("a copy already running leaves the window where it is", async () => {
  const shown = [];
  const window = createCloudWindow({
    autoMove: { ensure: async () => ({ status: "busy" }), retry: async () => ({ status: "busy" }), stop() {} },
    hold: { set: async () => {} },
    destinationFor: choice => ({ id: "cloud", name: "My Cloud", origin: choice.origin, kind: "cloud" }),
    showHome: destination => shown.push(destination.origin),
  });
  assert.deepEqual(await window.sync(connected()), { kind: "keep" });
  assert.deepEqual(shown, []);
});

test("a home used after a failed copy is never replaced: not by the copy trying again on its own, not by Try again, not after a relaunch", async () => {
  const m = mac({ moveFails: "network", homeHasTestDogs: false });
  await m.window.sync(connected());
  assert.deepEqual(m.log.window, [`home ${HOME}`]);
  m.home.workspace = "chats-on-the-home";
  m.control.moveFails = null;
  await m.log.timers[0].run();
  assert.equal(m.home.workspace, "chats-on-the-home");
  assert.equal(m.home.previousKept, false, "nothing on the home was set aside");
  assert.deepEqual(m.log.moves.map(entry => entry.requireEmpty), [false, true]);
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000], "a home that already has dogs ends the automatic copies");
  assert.equal(m.dogs.held, false, "the Mac's dogs keep working");
  assert.deepEqual(m.log.failures.map(reason => reason.code), ["network", "not_empty"]);
  await m.window.retry(connected());
  assert.equal(m.home.workspace, "chats-on-the-home");
  assert.equal(m.log.moves.at(-1).requireEmpty, true);
  const relaunched = mac({ saved: m.store.raw, homeHasTestDogs: false });
  relaunched.home.workspace = "chats-on-the-home";
  assert.equal((await relaunched.window.sync(connected())).kind, "cloud");
  assert.equal(relaunched.home.workspace, "chats-on-the-home");
  assert.deepEqual(relaunched.log.moves.map(entry => entry.requireEmpty), [true]);
});

test("a retry that starts on a still-empty home stops at commit when the person chats on the home during the copy, and the Mac's dogs work again", async () => {
  const m = mac({ moveFails: "network", homeHasTestDogs: false });
  await m.window.sync(connected());
  m.control.moveFails = null;
  m.control.duringCopy = home => { home.workspace = "chats-on-the-home"; };
  await m.log.timers[0].run();
  assert.equal(m.home.workspace, "chats-on-the-home");
  assert.equal(m.home.previousKept, false, "nothing on the home was set aside");
  assert.deepEqual(m.log.failures.map(reason => reason.code), ["network", "not_empty"]);
  assert.deepEqual(m.log.timers.map(timer => timer.ms), [20_000], "a home that gained chats ends the automatic copies");
  assert.deepEqual(m.log.hold, [false, true, false, true, false], "the Mac's dogs are released once the copy stops");
  assert.equal(m.dogs.held, false);
});

test("a home still empty after a failed copy gets the Mac's dogs when the copy tries again", async () => {
  const m = mac({ moveFails: "network", homeHasTestDogs: false });
  await m.window.sync(connected());
  m.control.moveFails = null;
  await m.log.timers[0].run();
  assert.equal(m.home.workspace, "mac-dogs");
  assert.equal(m.dogs.held, true);
});
