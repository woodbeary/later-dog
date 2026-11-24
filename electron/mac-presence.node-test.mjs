import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { appNameForPid, createMacPresence, presencePoint, presenceStep } from "./mac-presence.mjs";
import { createPresenceOverlay, pillBounds, PILL_SIZE } from "./presence-overlay.mjs";

const HOME = "/Users/jo";
const home = { home: true, folders: [{ id: "f", name: "Home" }] };
const screen = (tool_name, args = {}) => ({ action: "computer_call", tool_name, arguments: args });

test("each step reads as plain words: what the dog is doing and where", () => {
  assert.equal(presenceStep(screen("click", { pid: 7 }), home, { app: "Notes" }), "clicking in Notes");
  assert.equal(presenceStep(screen("type_text"), home), "typing");
  assert.equal(presenceStep(screen("launch_app", { bundle_id: "com.apple.Notes" }), home), "opening Notes");
  assert.equal(presenceStep(screen("launch_app", { name: "Safari" }), home), "opening Safari");
  assert.equal(presenceStep(screen("get_window_state", { pid: 7 }), home, { app: "Mail" }), "looking at Mail");
  assert.equal(presenceStep(screen("something_new"), home), "using apps");
  assert.equal(presenceStep({ action: "run_command", cwd: `${HOME}/code/app` }, home, { home: HOME }), "running a command in ~/code/app");
  assert.equal(presenceStep({ action: "run_command" }, home), "running a command");
  assert.equal(presenceStep({ action: "read_file", path: "Documents/plan.md" }, home), "reading files in Documents");
  assert.equal(presenceStep({ action: "list_files", path: "" }, home), "looking through files in your home folder");
  const folders = { folders: [{ id: "d", name: "Designs" }] };
  assert.equal(presenceStep({ action: "write_file", folder_id: "d", path: "logo/a.svg" }, folders), "writing files in Designs/logo");
  assert.equal(presenceStep({ action: "read_file", folder_id: "x", path: "a.txt" }, folders), "reading files in a shared folder");
  assert.equal(presenceStep({ action: "computer_tools" }, home), "getting ready to use apps");
  assert.equal(presenceStep(screen("click"), home, { app: "Bad\u0000\nApp" }), "clicking in Bad App");
});

test("the pill goes to the display where a click lands, and nowhere for window-relative actions", () => {
  assert.deepEqual(presencePoint(screen("click", { x: 2100, y: 40 })), { x: 2100, y: 40 });
  assert.equal(presencePoint(screen("click", { pid: 3, x: 10, y: 10 })), null);
  assert.equal(presencePoint({ action: "run_command", x: 1, y: 1 }), null);
});

test("an app's name comes from its bundle, and a bad pid never runs anything", async () => {
  const ran = [];
  const run = (file, args, _options, done) => { ran.push([file, ...args]); done(null, "/Applications/Notes.app/Contents/MacOS/Notes\n"); };
  assert.equal(await appNameForPid(42, { run }), "Notes");
  assert.equal(await appNameForPid(-1, { run }), "");
  assert.deepEqual(ran, [["/bin/ps", "-p", "42", "-o", "comm="]]);
});

function watch({ shown = true, lingerMs = 40 } = {}) {
  const rendered = [], described = [], cursor = [];
  let visible = shown;
  const presence = createMacPresence({
    shown: () => visible, lingerMs, home: HOME, appName: async () => "Notes",
    render: state => rendered.push(state), describe: state => described.push(state),
  });
  const turn = async (on, session) => { cursor.push([on, session]); };
  return { presence, rendered, described, cursor, turn, show: on => { visible = on; } };
}

test("while a dog works the pill and menu bar name it and its step, the cursor turns on once, and all of it fades about 2 s after the last action", async () => {
  const { presence, rendered, described, cursor, turn } = watch();
  await presence.begin({ id: "a", by: "Rex", operation: screen("click", { pid: 9 }), grant: home, cursor: turn });
  await delay(5);
  assert.deepEqual(rendered.at(-1), { name: "Rex", step: "clicking in Notes", screen: true, point: null });
  assert.deepEqual(described.at(-1), rendered.at(-1));
  presence.end("a");
  await presence.begin({ id: "b", by: "Rex", operation: screen("type_text", { pid: 9 }), grant: home, cursor: turn });
  presence.end("b");
  assert.deepEqual(cursor, [[true, ""]], "one cursor for the session, not one per step");
  assert.notEqual(rendered.at(-1), null, "it lingers between steps");
  await delay(80);
  assert.equal(rendered.at(-1), null);
  assert.equal(described.at(-1), null);
  assert.deepEqual(cursor, [[true, ""], [false, ""]]);
});

test("files and commands show the pill but no glow and no cursor, and an unnamed request says My Cloud", async () => {
  const { presence, rendered, cursor, turn } = watch();
  await presence.begin({ id: "c", by: "", operation: { action: "run_command", cwd: `${HOME}/code/app` }, grant: home, cursor: turn });
  assert.deepEqual(rendered.at(-1), { name: "My Cloud", step: "running a command in ~/code/app", screen: false, point: null });
  assert.deepEqual(cursor, []);
  presence.stop();
});

test("with the setting off nothing is drawn and the cursor stays off, but the menu bar still names the dog; turning it off mid-step hides at once", async () => {
  const off = watch({ shown: false });
  await off.presence.begin({ id: "a", by: "Rex", operation: screen("click"), grant: home, cursor: off.turn });
  assert.deepEqual(off.rendered, []);
  assert.deepEqual(off.cursor, []);
  assert.equal(off.described.at(-1).name, "Rex");
  off.presence.stop();
  const on = watch();
  await on.presence.begin({ id: "a", by: "Rex", operation: screen("click"), grant: home, cursor: on.turn });
  on.show(false);
  on.presence.shownChanged();
  await delay(5);
  assert.equal(on.rendered.at(-1), null);
  assert.deepEqual(on.cursor, [[true, ""], [false, ""]]);
  on.presence.stop();
});

test("Stop clears the pill and the cursor right away, without waiting to fade", async () => {
  const { presence, rendered, described, cursor, turn } = watch({ lingerMs: 10_000 });
  await presence.begin({ id: "a", by: "Rex", operation: screen("click"), grant: home, cursor: turn });
  presence.stop();
  assert.equal(rendered.at(-1), null);
  assert.equal(described.at(-1), null);
  await delay(5);
  assert.deepEqual(cursor, [[true, ""], [false, ""]]);
});

test("a cursor that never answers doesn't hold up the dog's action", async () => {
  const presence = createMacPresence({ cursorWaitMs: 30, lingerMs: 10 });
  const started = Date.now();
  await presence.begin({ id: "a", by: "Rex", operation: screen("click"), grant: home, cursor: () => new Promise(() => {}) });
  assert.ok(Date.now() - started < 1000);
  presence.stop();
});

function electronFake() {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      Object.assign(this, { options, calls: [], visible: false, destroyed: false, bounds: null });
      const contents = this;
      this.handlers = {};
      this.webContents = { setWindowOpenHandler() {}, on: (event, handler) => { contents.handlers[event] = handler; }, isLoading: () => true, send: (...args) => contents.calls.push(["send", ...args]) };
      windows.push(this);
    }
    setAlwaysOnTop(...args) { this.calls.push(["top", ...args]); }
    setVisibleOnAllWorkspaces() {}
    setContentProtection(on) { this.calls.push(["protect", on]); }
    setIgnoreMouseEvents(...args) { this.calls.push(["ignore", ...args]); }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; this.calls.push(["showInactive"]); }
    show() { this.calls.push(["show"]); }
    focus() { this.calls.push(["focus"]); }
    hide() { this.visible = false; }
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; }
  }
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 33, width: 1512, height: 949 } };
  const side = { id: 2, bounds: { x: 1512, y: 0, width: 2560, height: 1440 }, workArea: { x: 1512, y: 25, width: 2560, height: 1415 } };
  const screen = { getPrimaryDisplay: () => main, getDisplayNearestPoint: point => (point.x >= 1512 ? side : main) };
  return { BrowserWindow, screen, windows, main, side };
}

test("the pill floats top centre without taking focus, stays out of screenshots, and only its Stop button takes clicks", async () => {
  const { BrowserWindow, screen, windows, main, side } = electronFake();
  let stops = 0;
  const overlay = createPresenceOverlay({ BrowserWindow, screen, onStop: () => stops++, platform: "darwin" });
  overlay.render({ name: "Rex", step: "running a command", screen: false, point: null });
  assert.equal(windows.length, 1, "no glow for a command");
  const [pill] = windows;
  assert.ok(!pill.calls.some(([kind]) => kind === "send"), "nothing is sent before the page has loaded");
  pill.handlers["did-finish-load"]();
  assert.deepEqual(pill.calls.filter(([kind]) => kind === "send").at(-1), ["send", "presence:state", { name: "Rex", step: "running a command", screen: false, point: null }], "the first step reaches the pill once it loads, though Electron still says it is loading");
  assert.equal(pill.options.focusable, false);
  assert.equal(pill.options.type, "panel");
  assert.equal(pill.options.skipTaskbar, true);
  assert.deepEqual(pill.calls.filter(([kind]) => kind !== "send").slice(0, 3), [["top", true, "screen-saver"], ["protect", true], ["ignore", true, { forward: true }]]);
  assert.ok(pill.calls.some(([kind]) => kind === "showInactive"));
  assert.ok(!pill.calls.some(([kind]) => kind === "show" || kind === "focus"), "never steals focus");
  assert.deepEqual(pill.bounds, pillBounds(main));
  assert.deepEqual(pillBounds(main), { x: 526, y: 39, width: PILL_SIZE.width, height: PILL_SIZE.height });
  overlay.render({ name: "Rex", step: "clicking", screen: true, point: { x: 2000, y: 300 } });
  assert.equal(windows.length, 2, "a glow while it uses apps");
  assert.deepEqual(pill.bounds, pillBounds(side), "on the display where the click lands");
  assert.deepEqual(windows[1].bounds, side.workArea, "the glow frames the usable screen, never under the menu bar or off its bottom edge");
  windows[1].handlers["did-finish-load"]();
  assert.equal(windows[1].calls.filter(([kind]) => kind === "send").at(-1)[2].screen, true);
  assert.equal(windows[1].options.focusable, false);
  overlay.hover({}, true);
  assert.deepEqual(pill.calls.filter(([kind]) => kind === "ignore").length, 1, "only the pill itself can make itself clickable");
  overlay.hover(pill.webContents, true);
  assert.deepEqual(pill.calls.filter(([kind]) => kind === "ignore").at(-1), ["ignore", false, { forward: true }]);
  assert.equal(overlay.stop({}), false);
  assert.equal(stops, 0);
  assert.equal(overlay.stop(pill.webContents), true);
  assert.equal(stops, 1);
  overlay.render(null);
  await delay(400);
  assert.deepEqual([pill.visible, windows[1].visible], [false, false]);
  overlay.destroy();
  assert.ok(windows.every(win => win.destroyed));
});
