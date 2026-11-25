import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLaunchTimeline,
  LAUNCH_TIMELINE_ARGUMENT,
  LAUNCH_TIMELINE_CHANNEL,
  LAUNCH_TIMELINE_ENV,
} from "./launch-timeline.mjs";

const clock = (start = 1_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

const fakeWindow = () => {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = () => false;
  return win;
};

test("without the variable it records nothing, writes nothing and adds no renderer argument", () => {
  const writes = [];
  const timeline = createLaunchTimeline({ env: {}, write: (...args) => writes.push(args) });
  assert.equal(timeline.enabled, false);
  timeline.mark("app-ready");
  timeline.receive("renderer-message-box-ready", 5);
  const ipc = new EventEmitter();
  timeline.listen(ipc);
  timeline.watchWindow(fakeWindow());
  assert.equal(timeline.close(), false);
  assert.deepEqual(timeline.rendererArguments(), []);
  assert.equal(ipc.listenerCount(LAUNCH_TIMELINE_CHANNEL), 0);
  assert.deepEqual(writes, []);
});

test("a blank variable is the same as no variable", () => {
  assert.equal(createLaunchTimeline({ env: { [LAUNCH_TIMELINE_ENV]: "  " } }).enabled, false);
});

test("the record is written in time order when the message box is ready, and again with later marks at quit", () => {
  const time = clock();
  const writes = [];
  const timeline = createLaunchTimeline({
    env: { [LAUNCH_TIMELINE_ENV]: "/out/run.json" },
    now: time.now,
    processStart: 900,
    write: (file, text) => writes.push({ file, report: JSON.parse(text) }),
    facts: () => ({ packaged: false }),
  });
  assert.deepEqual(timeline.rendererArguments(), [LAUNCH_TIMELINE_ARGUMENT]);
  timeline.mark("app-ready");
  time.advance(40);
  timeline.mark("create-window");
  timeline.mark("create-window");
  time.advance(10);
  timeline.receive("renderer-first-paint", 1_020);
  timeline.receive("not-a-renderer-mark", 1_030);
  time.advance(100);
  timeline.receive("renderer-message-box-ready", 1_140, { snapshot: true, ignored: { nested: 1 } });
  timeline.receive("renderer-message-box-ready", 1_145);
  assert.equal(writes.length, 1);
  const { file, report } = writes[0];
  assert.equal(file, "/out/run.json");
  assert.equal(report.outcome, "complete");
  assert.equal(report.packaged, false);
  assert.equal(report.processStart, 900);
  assert.deepEqual(report.marks.map((entry) => entry.name), [
    "main-process-start",
    "app-ready",
    "renderer-first-paint",
    "create-window",
    "renderer-first-paint-received",
    "renderer-message-box-ready",
    "renderer-message-box-ready-received",
  ]);
  assert.deepEqual(report.marks.find((entry) => entry.name === "renderer-message-box-ready").detail, { snapshot: true });
  assert.equal(report.marks.find((entry) => entry.name === "create-window").sinceStartMs, 140);
  time.advance(30);
  timeline.mark("window-shown");
  assert.equal(timeline.close(), true);
  timeline.mark("after-quit");
  assert.equal(timeline.close(), false);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].report.outcome, "complete");
  assert.deepEqual(writes[1].report.marks.map((entry) => entry.name).slice(-2), ["renderer-message-box-ready-received", "window-shown"]);
});

test("a launch that ends before the message box still leaves a partial record", () => {
  const writes = [];
  const timeline = createLaunchTimeline({ env: { [LAUNCH_TIMELINE_ENV]: "/out/run.json" }, now: () => 5, processStart: 1, write: (_file, text) => writes.push(JSON.parse(text)) });
  timeline.mark("app-ready");
  assert.equal(timeline.close(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].outcome, "quit-before-message-box");
});

test("window events and renderer messages from the watched window become marks", () => {
  const time = clock();
  const writes = [];
  const timeline = createLaunchTimeline({ env: { [LAUNCH_TIMELINE_ENV]: "/out/run.json" }, now: time.now, processStart: 0, write: (_file, text) => writes.push(JSON.parse(text)) });
  const ipc = new EventEmitter();
  timeline.listen(ipc);
  const win = fakeWindow();
  const other = fakeWindow();
  timeline.watchWindow(win);
  timeline.watchWindow(other);
  time.advance(5);
  win.emit("ready-to-show");
  time.advance(5);
  win.webContents.emit("did-finish-load");
  time.advance(5);
  win.emit("show");
  time.advance(100);
  ipc.emit(LAUNCH_TIMELINE_CHANNEL, { sender: other.webContents }, "renderer-message-box-ready", 1_050);
  assert.equal(writes.length, 0);
  ipc.emit(LAUNCH_TIMELINE_CHANNEL, { sender: win.webContents }, "renderer-message-box-ready", 1_050);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].marks.map((entry) => entry.name), [
    "main-process-start",
    "window-ready-to-show",
    "window-did-finish-load",
    "window-shown",
    "renderer-message-box-ready",
    "renderer-message-box-ready-received",
  ]);
});

test("the default writer leaves one complete file and no partial", () => {
  const folder = mkdtempSync(join(tmpdir(), "launch-timeline-"));
  try {
    const file = join(folder, "nested", "run.json");
    const timeline = createLaunchTimeline({ env: { [LAUNCH_TIMELINE_ENV]: file } });
    timeline.mark("app-ready");
    assert.equal(timeline.close(), true);
    const report = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(report.marks.at(-1).name, "app-ready");
    assert.ok(report.marks.every((entry) => entry.sinceStartMs >= 0));
    assert.equal(existsSync(`${file}.${process.pid}.partial`), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
