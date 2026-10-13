import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  attachDesktopViewerPill,
  desktopViewerPill,
  desktopViewerPillBounds,
  desktopViewerPillDone,
  desktopViewerPillPage,
} = require("./desktop-viewer-pill.cjs");

const pageHtml = (url) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));

test("shows no pill unless the app asks for one, and falls back to plain words", () => {
  assert.equal(desktopViewerPill(undefined), null);
  assert.equal(desktopViewerPill("You're in control"), null);
  assert.deepEqual(desktopViewerPill({}), { label: "You're in control", done: "I'm done" });
  assert.deepEqual(desktopViewerPill({ label: "  Tienes\n el control ", done: 7 }), { label: "Tienes el control", done: "I'm done" });
  assert.equal(desktopViewerPill({ label: "x".repeat(200) }).label.length, 40);
});

test("renders labels as text with no script and nothing loaded from anywhere", () => {
  const html = pageHtml(desktopViewerPillPage({ label: "<img src=x onerror=alert(1)>", done: "\"I'm done\"" }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;I&#39;m done&quot;/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<a href="#done">/);
});

test("only the pill's own done link counts as done", () => {
  const page = desktopViewerPillPage({ label: "You're in control", done: "I'm done" });
  assert.equal(desktopViewerPillDone(`${page}#done`), true);
  assert.equal(desktopViewerPillDone(page), false);
  assert.equal(desktopViewerPillDone("https://desktop.example/vnc.html#done"), false);
  assert.equal(desktopViewerPillDone("not a url"), false);
});

test("sits centred at the top and never wider than the window", () => {
  const pill = { label: "You're in control", done: "I'm done" };
  const wide = desktopViewerPillBounds(1200, pill);
  assert.equal(wide.y, 14);
  assert.equal(wide.height, 40);
  assert.ok(Math.abs(wide.x * 2 + wide.width - 1200) <= 1);
  assert.ok(wide.width >= 220 && wide.width <= 420);
  assert.ok(desktopViewerPillBounds(1200, { label: "x".repeat(40), done: "y".repeat(40) }).width <= 420);
  assert.ok(desktopViewerPillBounds(200, pill).width <= 176);
});

test("closes the viewer when the person taps done and cleans up with the window", () => {
  const listeners = new Map();
  const viewerListeners = new Map();
  let closed = 0;
  let added = null;
  const contents = {
    loaded: null,
    closedWith: null,
    on(name, handler) { listeners.set(name, handler); },
    setWindowOpenHandler(handler) { this.openHandler = handler; },
    loadURL(url) { this.loaded = url; return Promise.resolve(); },
    isDestroyed() { return this.closedWith !== null; },
    close(options) { this.closedWith = options; },
  };
  const viewer = {
    isDestroyed: () => closed > 0,
    close: () => { closed += 1; viewerListeners.get("closed")?.(); },
    getContentSize: () => [1000, 700],
    on(name, handler) { viewerListeners.set(name, handler); },
    once(name, handler) { viewerListeners.set(name, handler); },
    contentView: { addChildView(view) { added = view; } },
  };
  let options = null;
  const view = attachDesktopViewerPill({
    viewer,
    pill: { label: "You're in control", done: "I'm done" },
    createView: (given) => {
      options = given;
      return { webContents: contents, setBounds(bounds) { this.bounds = bounds; }, setBackgroundColor(color) { this.background = color; } };
    },
  });
  assert.equal(added, view);
  assert.equal(options.webPreferences.javascript, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(view.background, "#00000000");
  assert.equal(view.bounds.y, 14);
  assert.match(contents.loaded, /^data:text\/html/);
  assert.deepEqual(contents.openHandler(), { action: "deny" });

  let prevented = false;
  listeners.get("will-navigate")({ preventDefault: () => { prevented = true; } }, "https://elsewhere.example/");
  assert.equal(prevented, true);
  assert.equal(closed, 0);

  listeners.get("did-navigate-in-page")({}, `${contents.loaded}#done`);
  assert.equal(closed, 1);
  assert.deepEqual(contents.closedWith, { waitForBeforeUnload: false });
});
