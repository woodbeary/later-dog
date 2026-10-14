import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAutoMove, parseMoveRecords, worthMoving } from "./cloud-auto-move.mjs";

const DEST = { id: "cloud", name: "My Cloud", origin: "https://home.fixture.test", kind: "cloud", grant: async () => ({}) };
const LOCAL = { bots: 4, rooms: 1, chats: 9, bytes: 1000, files: 3 };

function setup(options = {}) {
  const stored = { raw: options.saved ?? null }, timers = [], moves = [], logs = [], arrivals = [];
  const results = [...(options.results ?? [])];
  const move = {
    running: () => Boolean(options.running),
    estimate: async () => { if (options.estimateFails) throw new Error("local server busy"); return options.local ?? LOCAL; },
    move: async (dest, flags) => { moves.push([dest, flags]); return results.shift() ?? { phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 9 } }; },
  };
  const engine = createCloudAutoMove({ move, read: () => stored.raw, write: contents => { if (options.writeFails) throw new Error("disk full"); stored.raw = contents; }, now: () => 1_800_000_000_000,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; }, clearTimer: () => { timers.length = 0; }, log: message => logs.push(message), retryDelaysMs: [10, 20], onMoved: destination => arrivals.push(destination) });
  return { engine, stored, timers, moves, logs, arrivals };
}
const failed = (code, extra = {}) => ({ phase: "failed", action: "move", error: { code, message: code, ...extra } });

test("dogs with chats move once, with the home required to be empty and to prove arrival, and the Mac keeps its copy", async () => {
  const f = setup();
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  assert.deepEqual(f.moves, [[DEST, { requireEmpty: true, verifyArrival: true }]]);
  assert.equal(f.engine.status("acct"), "moved");
  assert.deepEqual(parseMoveRecords(f.stored.raw).acct.contents, { bots: 4, rooms: 1, chats: 9 });
  assert.deepEqual(f.arrivals, [DEST], "the window is told so it can show the dogs that arrived");
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  assert.equal(f.arrivals.length, 1);
  assert.equal(f.moves.length, 1, "a finished move is never started again");
});

test("a Mac with only the starter dog and no chats has nothing to move, and that is remembered", async () => {
  const f = setup({ local: { bots: 1, rooms: 0, chats: 0, bytes: 10, files: 0 } });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "nothing" });
  assert.equal(f.moves.length, 0);
  assert.equal(f.engine.status("acct"), "nothing");
  assert.equal(worthMoving({ bots: 2, rooms: 0, chats: 0 }), true);
  assert.equal(worthMoving(null), false);
});

test("a home that already has other dogs is never replaced automatically; the Mac's dogs stay and the choice is remembered", async () => {
  const f = setup({ results: [failed("not_empty", { contents: { bots: 2, rooms: 0, chats: 3 } })] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "kept-local" });
  assert.equal(f.engine.status("acct"), "kept-local");
  await f.engine.ensure("acct", DEST);
  assert.equal(f.moves.length, 1);
});

test("a home that is not empty because an earlier attempt already delivered everything counts as moved", async () => {
  const f = setup({ results: [failed("not_empty", { contents: { bots: 4, rooms: 1, chats: 9 } })] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
});

test("a move the home cannot confirm in full is not recorded, so nothing is treated as moved", async () => {
  const f = setup({ results: [failed("not_verified", { contents: { bots: 4, rooms: 1, chats: 5 } })] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "failed", code: "not_verified" });
  assert.equal(f.engine.status("acct"), null);
  const short = setup({ results: [{ phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 8 } }] });
  assert.deepEqual(await short.engine.ensure("acct", DEST), { status: "failed", code: undefined });
  assert.equal(short.engine.status("acct"), null, "a done that falls short is not believed");
});

test("a failure that can pass retries by itself on a growing delay, then waits for the person's retry", async () => {
  const f = setup({ results: [failed("busy"), failed("network"), failed("cloud_busy")] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "waiting", code: "busy" });
  assert.equal(f.timers[0].delay, 10);
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "waiting" }, "asking again while a retry is scheduled does not stack another");
  f.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers.at(-1).delay, 20);
  f.timers.at(-1).callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.moves.length, 3);
  assert.equal(f.engine.status("acct"), null);
  assert.deepEqual(await f.engine.retry("acct", DEST), { status: "moved" }, "the person's retry starts over");
});

test("a failure that will not pass by waiting is reported once and not retried", async () => {
  const f = setup({ results: [failed("too_large")] });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "failed", code: "too_large" });
  assert.equal(f.timers.length, 0);
});

test("a busy local server or a move already under way never starts a second one", async () => {
  const running = setup({ running: true });
  assert.deepEqual(await running.engine.ensure("acct", DEST), { status: "busy" });
  assert.equal(running.moves.length, 0);
  const unmeasured = setup({ estimateFails: true });
  assert.deepEqual(await unmeasured.engine.ensure("acct", DEST), { status: "waiting", code: "unmeasured" });
});

test("a result that cannot be saved is logged and the move is not claimed finished on disk", async () => {
  const f = setup({ writeFails: true });
  assert.deepEqual(await f.engine.ensure("acct", DEST), { status: "moved" });
  assert.match(f.logs[0], /could not save/);
  assert.equal(f.engine.status("acct"), null);
});

test("records belong to the account: another account on the same Mac is offered the move again, and damaged files read as none", async () => {
  const f = setup();
  await f.engine.ensure("first", DEST);
  assert.equal(f.engine.status("second"), null);
  assert.deepEqual(parseMoveRecords("not json"), {});
  assert.deepEqual(parseMoveRecords({ homes: { a: { status: "moved" }, b: { status: "weird", at: 1 }, c: { status: "nothing", at: 5 } } }), { c: { status: "nothing", at: 5 } });
});

test("a person's retry after a kept-local answer may try again, because the home may have been emptied since", async () => {
  const f = setup({ results: [failed("not_empty", { contents: { bots: 1, rooms: 0, chats: 0 } })] });
  await f.engine.ensure("acct", DEST);
  assert.deepEqual(await f.engine.retry("acct", DEST), { status: "moved" });
  assert.equal(f.moves.length, 2);
});
