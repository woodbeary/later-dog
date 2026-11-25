import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const sends = [];
const fakeElectron = {
  ipcRenderer: { on: () => {}, removeListener: () => {}, invoke: async () => {}, send: (...args) => sends.push(args), sendSync: () => false },
  contextBridge: { exposeInMainWorld: () => {} },
  webUtils: { getPathForFile: () => "" },
};
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = { id: electronEntry, filename: electronEntry, loaded: true, exports: fakeElectron };

const page = { rootChildren: 0, splash: null, composer: false };
const element = (attributes) => ({ getAttribute: (name) => attributes[name] ?? null });
let mutate = () => {};
let disconnected = false;
let paintEntries = () => {};
const domReady = [];
const visibilityChanges = [];
const globals = {
  localStorage: { getItem: (key) => (key === "laterdog-first-paint" ? "{}" : null) },
  PerformanceObserver: class {
    constructor(callback) { paintEntries = (entries) => callback({ getEntries: () => entries }); }
    observe() {}
  },
  MutationObserver: class {
    constructor(callback) { mutate = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  },
  document: {
    documentElement: {},
    visibilityState: "hidden",
    addEventListener: (name, callback) => {
      if (name === "DOMContentLoaded") domReady.push(callback);
      if (name === "visibilitychange") visibilityChanges.push(callback);
    },
    getElementById: (id) => (id === "root" ? { childElementCount: page.rootChildren } : null),
    querySelector: (selector) => {
      if (selector === "[data-launch-splash]") return page.splash ? element({ "data-launch-splash": page.splash }) : null;
      if (selector === "[data-composer-surface] textarea") return page.composer ? {} : null;
      return null;
    },
  },
};
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const names = () => sends.filter(([channel]) => channel === "launch-timeline:mark").map(([, name]) => name);

test("without the flag the preload sends no launch marks", () => {
  require("./preload.cjs");
  assert.deepEqual(names(), []);
  assert.equal(domReady.length, 0);
  delete require.cache[require.resolve("./preload.cjs")];
});

test("with the flag the preload reports paint, splash and a visible message box once each", () => {
  process.argv.push("--laterdog-launch-timeline=1");
  try {
    require("./preload.cjs");
  } finally {
    process.argv.pop();
  }
  assert.deepEqual(names(), ["renderer-started"]);
  assert.deepEqual(sends[0][3], { snapshot: true });
  domReady.forEach((callback) => callback());
  paintEntries([{ name: "first-paint", startTime: 4 }, { name: "first-contentful-paint", startTime: 5 }]);
  page.rootChildren = 1;
  page.splash = "shown";
  page.composer = true;
  mutate();
  page.splash = "leaving";
  mutate();
  mutate();
  page.splash = null;
  mutate();
  assert.equal(names().includes("renderer-message-box-ready"), false);
  globalThis.document.visibilityState = "visible";
  visibilityChanges.forEach((callback) => callback());
  mutate();
  assert.deepEqual(names(), [
    "renderer-started",
    "renderer-first-paint",
    "renderer-root-filled",
    "renderer-launch-splash-shown",
    "renderer-launch-splash-leaving",
    "renderer-message-box-ready",
  ]);
  const paint = sends.find(([, name]) => name === "renderer-first-paint");
  assert.equal(paint[2], performance.timeOrigin + 5);
  assert.deepEqual(sends.at(-1)[3], { snapshot: true });
  assert.equal(disconnected, true);
});
