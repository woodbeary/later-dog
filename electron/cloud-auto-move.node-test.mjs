import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAutoMove, parseMoveRecords, worthMoving } from "./cloud-auto-move.mjs";

const DEST = { id: "cloud", name: "My Cloud", origin: "https://home.fixture.test", kind: "cloud", grant: async () => ({}) };
const LOCAL = { bots: 4, rooms: 1, chats: 9, bytes: 1000, files: 3 };
const STAYED = [{ name: "task-workspaces", bytes: 5000 }, { name: "native", bytes: 1600 }];

function setup(options = {}) {
  const stored = { raw: options.saved ?? null }, moves = [], logs = [], arrivals = [], joins = [], failures = [];
  const results = [...(options.results ?? [])];
  const move = {
    running: () => Boolean(options.running),
    estimate: async () => { if (options.estimateFails) throw new Error("local server busy"); return options.local ?? LOCAL; },
    move: async (dest, flags) => { moves.push([dest, flags]); return results.shift() ?? { phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 9 }, stayedOnMac: STAYED }; },
  };
  const engine = createCloudAutoMove({ move, read: () => stored.raw, write: contents => { if (options.writeFails) throw new Error("disk full"); stored.raw = contents; }, now: () => 1_800_000_000_000,
    log: message => logs.push(message), onMoved: destination => arrivals.push(destination), onJoined: destination => joins.push(destination), onFailed: reason => failures.push(reason) });
  return { engine, stored, moves, logs, arrivals, joins, failures };
}
const failed = (code, extra = {}) => ({ phase: "failed", action: "move", error: { code, message: code, ...extra } });

test("the first sign-in moves the Mac's dogs with replacement allowed, the slim profile and proof of arrival, and records account and home", async () => {
  const f = setup();
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  const [[destination, { onPacked, ...flags }]] = f.moves;
  assert.deepEqual([destination, flags], [DEST, { requireEmpty: false, verifyArrival: true, profile: "cloud-move", yieldToOtherComputer: true, fresh: true }]);
  assert.equal(typeof onPacked, "function");
  const record = parseMoveRecords(f.stored.raw).acct;
  assert.equal(record.status, "moved");
  assert.equal(record.origin, DEST.origin);
  assert.deepEqual(record.contents, { bots: 4, rooms: 1, chats: 9 });
  assert.deepEqual(record.stayedOnMac, STAYED);
  assert.deepEqual(f.arrivals, [DEST]);
});

test("a later sign-in on the same Mac only shows the home: the move never repeats", async () => {
  const f = setup();
  await f.engine.ensure("acct", DEST);
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  assert.deepEqual(await f.engine.retry("acct", DEST), { status: "moved" });
  assert.equal(f.moves.length, 1);
  assert.equal(f.engine.status("acct", DEST), "moved");
  const restarted = createCloudAutoMove({ move: { running: () => false, estimate: async () => LOCAL, move: async () => { throw new Error("must not move"); } }, read: () => f.stored.raw, write() {} });
  assert.deepEqual(await restarted.ensure("acct", DEST), { status: "moved" });
});

test("another account on the same Mac is a separate decision", async () => {
  const f = setup();
  await f.engine.ensure("acct", DEST);
  await f.engine.ensure("other", DEST);
  assert.equal(f.moves.length, 2);
});

test("a Mac with only the starter dog and no chats has nothing to move and records nothing", async () => {
  const f = setup({ local: { bots: 1, rooms: 0, chats: 0, bytes: 10, files: 0 } });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "nothing" });
  assert.equal(f.moves.length, 0);
  assert.equal(f.stored.raw, null);
  assert.equal(worthMoving({ bots: 2, rooms: 0, chats: 0 }), true);
  assert.equal(worthMoving({ bots: 1, rooms: 0, chats: 2 }), true);
  assert.equal(worthMoving(null), false);
});

test("a second Mac does not replace a home that another Mac filled: it records that, logs one line and leaves its own data alone", async () => {
  const f = setup({ results: [failed("other_computer_moved")] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "joined" });
  assert.equal(f.engine.status("acct", DEST), "joined");
  assert.deepEqual(f.joins, [DEST]);
  assert.equal(f.arrivals.length, 0);
  assert.equal(f.logs.filter(line => /another computer already moved/.test(line)).length, 1);
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "joined" });
  assert.equal(f.moves.length, 1);
});

test("a home at a different address than the one that received the move is decided again", async () => {
  const f = setup();
  await f.engine.ensure("acct", DEST);
  await f.engine.ensure("acct", { ...DEST, origin: "https://other-home.fixture.test" });
  assert.equal(f.moves.length, 2);
});

test("a move the home cannot confirm in full is not recorded and is reported once with its reason", async () => {
  const f = setup({ results: [failed("not_verified", { contents: { bots: 4, rooms: 1, chats: 5 } })] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "failed", code: "not_verified" });
  assert.equal(f.stored.raw, null);
  assert.deepEqual(f.failures.map(reason => reason.code), ["not_verified"]);
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "failed" });
  assert.equal(f.moves.length, 1, "no retry timer: the next launch tries again");
  assert.equal(f.failures.length, 1);
  const short = setup({ results: [{ phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 8 } }] });
  assert.equal((await short.engine.ensure("acct", DEST)).status, "failed");
  assert.equal(short.stored.raw, null);
});

test("a new launch tries a failed move again, and so does an explicit retry", async () => {
  const f = setup({ results: [failed("network")] });
  assert.equal((await f.engine.ensure("acct", DEST)).status, "failed");
  assert.deepEqual(await f.engine.retry("acct", DEST), { status: "moved" });
  const g = setup({ results: [failed("network")] });
  await g.engine.ensure("acct", DEST);
  g.engine.stop();
  assert.deepEqual(await g.engine.ensure("acct", DEST), { status: "moved" });
});

test("a failure that can pass on its own is tried again on a growing schedule; one that cannot is not, and the log keeps the reason", async () => {
  const f = setup({ results: [failed("network"), failed("busy"), failed("upload_failed"), failed("cloud_unavailable"), failed("network")] });
  const waits = [];
  for (let i = 0; i < 5; i++) waits.push((await f.engine.retry("acct", DEST)).retryInMs);
  assert.deepEqual(waits, [20_000, 60_000, 300_000, 900_000, undefined]);
  assert.match(f.logs[0], /not moved \(network\): network Trying again in 20 s\./);
  const full = setup({ results: [failed("cloud_full")] });
  assert.deepEqual(await full.engine.ensure("acct", DEST), { status: "failed", code: "cloud_full" });
});

test("the Mac's dogs pause only once packed, a pause left by a quit is lifted first, a stop is final, and a copy the Cloud already took keeps them paused", async () => {
  const pauses = [];
  const run = async (result) => {
    const engine = createCloudAutoMove({ read: () => null, write: () => {}, pause: async held => { pauses.push(held); },
      move: { running: () => false, estimate: async () => LOCAL, move: async (_dest, flags) => { await flags.onPacked(); return result; } } });
    return engine.ensure("acct", DEST);
  };
  assert.deepEqual(await run(failed("upload_failed")), { status: "failed", code: "upload_failed", retryInMs: 20_000 });
  assert.deepEqual(pauses.splice(0), [false, true, false]);
  assert.deepEqual(await run(failed("cancelled")), { status: "failed", code: "cancelled" });
  assert.deepEqual(pauses.splice(0), [false, true, false]);
  assert.deepEqual(await run(failed("restart_timeout", { committed: true })), { status: "failed", code: "restart_timeout", retryInMs: 20_000 });
  assert.deepEqual(pauses.splice(0), [false, true], "the Cloud already runs these dogs, so the Mac stays paused");
});

test("an unmeasurable Mac or a move already running does nothing harmful", async () => {
  const unmeasured = setup({ estimateFails: true });
  assert.deepEqual(await unmeasured.engine.ensure("acct", DEST), { status: "failed", code: "unmeasured", retryInMs: 20_000 });
  const running = setup({ running: true });
  assert.deepEqual(await running.engine.ensure("acct", DEST), { status: "busy" });
  assert.equal(running.moves.length, 0);
  assert.deepEqual(await running.engine.ensure(null, DEST), { status: "busy" });
});

test("records from older builds that kept the Mac's dogs local or found nothing do not block the move", () => {
  const raw = JSON.stringify({ version: 1, homes: {
    a: { status: "kept-local", at: 1, origin: DEST.origin }, b: { status: "nothing", at: 1, origin: DEST.origin }, c: { status: "moved", at: 1 }, d: { status: "moved", at: 2, origin: DEST.origin },
  } });
  assert.deepEqual(Object.keys(parseMoveRecords(raw)), ["d"]);
  assert.deepEqual(parseMoveRecords("garbage"), {});
});

test("a record that cannot be saved is logged, and the move still counts as done for this launch", async () => {
  const f = setup({ writeFails: true });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  assert.ok(f.logs.some(line => /could not save/.test(line)));
});
