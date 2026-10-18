import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { patchMacUpdater } from "../scripts/patch-mac-updater.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function readHttp(url, headers) {
  return new Promise((resolve, reject) => {
    get(url, { headers, agent: false }, (response) => {
      const bytes = [];
      response.on("data", (chunk) => bytes.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(bytes) }));
    }).on("error", reject);
  });
}

function withVendoredUpdater(native, create) {
  const originalLoad = Module._load;
  Module._load = (name, ...args) => name === "electron" ? { autoUpdater: native } : originalLoad(name, ...args);
  try {
    return create(createRequire(import.meta.url)("./vendor/electron-updater.cjs"));
  } finally {
    Module._load = originalLoad;
  }
}

function harness(t, { fetchZip = true } = {}) {
  const native = new EventEmitter();
  const nativeCalled = deferred();
  const transferred = deferred();
  let feed;
  let quitCalls = 0;
  let downloads = 0;
  let checks = 0;
  let nativeChecks = 0;
  native.setFeedURL = (value) => { feed = value; };
  native.quitAndInstall = () => { quitCalls += 1; };
  native.checkForUpdates = () => {
    nativeChecks += 1;
    nativeCalled.resolve();
    if (!fetchZip) return;
    void (async () => {
      assert.equal((await readHttp(feed.url)).status, 401);
      const metadata = await readHttp(feed.url, feed.headers);
      assert.equal(metadata.status, 200);
      const zip = await readHttp(JSON.parse(metadata.body).url);
      assert.equal(zip.status, 200);
      assert.equal(zip.body.toString(), "fixture ZIP bytes");
      transferred.resolve();
    })().catch(transferred.reject);
  };
  const updater = withVendoredUpdater(native, ({ MacUpdater }) => new MacUpdater(null, { version: "1.0.0", quit: () => assert.fail("unexpected app quit") }));
  const warnings = [];
  updater.logger = { info() {}, warn(message) { warnings.push(message); }, error() {}, debug() {} };
  updater.autoInstallOnAppQuit = false;
  const workspace = mkdtempSync(join(tmpdir(), "laterdog-native-stage-"));
  const zip = join(workspace, "update.zip");
  writeFileSync(zip, "fixture ZIP bytes");
  t.after(async () => {
    if (updater.server?.listening) {
      await new Promise((resolve) => updater.server.close(resolve));
    }
    native.removeAllListeners();
    rmSync(workspace, { recursive: true, force: true });
  });
  let transfer = null;
  updater.downloadUpdate = () => {
    downloads += 1;
    transfer = updater.updateDownloaded(
      { info: { size: 17 }, url: new URL("https://fixture.invalid/update.zip") },
      { version: "2.0.0", downloadedFile: zip },
    );
    return transfer;
  };
  updater.checkForUpdates = async () => { checks += 1; };
  let state = { status: "idle" };
  const states = [];
  const receipts = [];
  const receipt = { write: (target) => receipts.push(["write", target]), clear: () => receipts.push(["clear"]) };
  const coordinator = createUpdaterCoordinator(updater, (patch) => {
    state = { ...state, ...patch };
    states.push({ ...state });
  }, { nativeStaging: true, receipt });
  const timers = new Map();
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 120_000 && delay !== 300_000) return originalTimeout(callback, delay, ...args);
    const timer = { unref() {} };
    timers.set(delay, { callback, timer });
    return timer;
  });
  const originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    for (const [delay, pending] of timers) {
      if (pending.timer === timer) { timers.delete(delay); return; }
    }
    originalClear(timer);
  });
  const found = async () => {
    const counting = updater.checkForUpdates;
    updater.checkForUpdates = async () => { updater.emit("update-available", { version: "2.0.0" }); };
    try { await coordinator.check(); } finally { updater.checkForUpdates = counting; }
  };
  const downloadSettled = async () => {
    await transfer?.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    native, updater, coordinator, states, timers, nativeCalled, transferred, warnings, found, downloadSettled, receipts,
    state: () => state,
    calls: () => ({ downloads, checks, nativeChecks, quitCalls }),
  };
}

test("a real Mac download is announced, and nothing is staged with macOS until the person says yes", async (t) => {
  const h = harness(t);
  await h.found();
  await h.downloadSettled();
  assert.equal(h.state().status, "downloaded");
  assert.equal(h.state().version, "2.0.0");
  assert.equal(h.updater.squirrelDownloadedUpdate, false);
  assert.equal(h.updater.server.listening, true, "the local feed stays open for a later yes");
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 0, quitCalls: 0 });
  assert.equal(h.states.some((entry) => entry.status === "preparing"), false);

  h.coordinator.install("1.9.0");
  h.coordinator.install(undefined);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 0, quitCalls: 0 });
  assert.equal(h.state().status, "downloaded");
  assert.deepEqual(h.receipts, []);
  t.diagnostic("downloaded -> no native checkForUpdates, so Squirrel.Mac has nothing it could install on quit; a different version is refused");
});

test("the yes stages the update with macOS, then restarts once and leaves a receipt", async (t) => {
  const h = harness(t);
  await h.found();
  await h.downloadSettled();

  h.coordinator.install("2.0.0");
  assert.equal(h.state().status, "preparing");
  await h.transferred.promise;
  assert.equal(h.timers.has(300_000), true);
  h.coordinator.install("2.0.0");
  await h.coordinator.check(true);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 1, quitCalls: 0 });
  assert.deepEqual(h.receipts, []);

  h.native.emit("update-downloaded");
  assert.equal(h.updater.squirrelDownloadedUpdate, true);
  assert.equal(h.state().status, "installing");
  assert.deepEqual(h.receipts, [["write", "2.0.0"]]);
  assert.equal(h.timers.has(300_000), false);
  assert.equal(h.native.listenerCount("update-downloaded"), 1, "the yes listener was removed");
  h.timers.get(120_000).callback();
  assert.equal(h.state().status, "installing");
  assert.match(h.state().message, /Quit and reopen/);
  assert.ok(h.warnings.some((message) => /restart handoff exceeded/.test(message)));
  h.coordinator.install("2.0.0");
  await h.coordinator.check(true);
  h.native.emit("update-downloaded");
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 1, quitCalls: 1 });
  t.diagnostic("yes -> preparing -> native ready -> one restart with a receipt; the watchdog and a late ready cannot repeat it");
});

test("a native staging deadline after the yes fails visibly without restarting or reviving on late readiness", async (t) => {
  const h = harness(t, { fetchZip: false });
  await h.found();
  await h.downloadSettled();
  h.coordinator.install("2.0.0");
  await h.nativeCalled.promise;
  assert.equal(h.state().status, "preparing");
  h.timers.get(300_000).callback();
  assert.equal(h.state().status, "error");
  assert.equal(h.state().retryable, false);
  assert.match(h.state().message, /took too long.*Quit and reopen/);
  assert.ok(h.warnings.some((message) => /preparation exceeded/.test(message)));
  const failed = h.state();
  await h.coordinator.check(true);
  h.coordinator.install("2.0.0");
  h.native.emit("update-downloaded");
  h.updater.emit("download-progress", { percent: 100 });
  h.updater.emit("update-downloaded", { version: "9.0.0" });
  assert.deepEqual(h.state(), failed);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 1, quitCalls: 0 });
  assert.equal(h.native.listenerCount("update-downloaded"), 1);
  assert.deepEqual(h.receipts, []);
  t.diagnostic("native never fetches ZIP -> deadline/error/retryable=false; late native ready keeps error, zero quits, no receipt");
});

test("native validation errors after the yes remain visible and clean up staging listeners", async (t) => {
  const h = harness(t);
  await h.found();
  await h.downloadSettled();
  h.coordinator.install("2.0.0");
  await h.transferred.promise;
  h.native.emit("error", new Error("signature validation failed"));
  assert.equal(h.state().status, "error");
  assert.equal(h.state().retryable, false);
  assert.match(h.state().message, /failed verification.*Quit and reopen/);
  assert.equal(h.states.filter((s) => s.status === "error").length, 1);
  assert.equal(h.native.listenerCount("error"), 1);
  assert.equal(h.native.listenerCount("update-downloaded"), 1);
  assert.equal(h.timers.has(300_000), false);
  const failed = h.state();
  await h.coordinator.check(true);
  h.coordinator.install("2.0.0");
  h.native.emit("update-downloaded");
  assert.deepEqual(h.state(), failed);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, nativeChecks: 1, quitCalls: 0 });
});

test("a Windows or AppImage updater with install-on-quit off registers nothing to run at quit", () => {
  const quitHandlers = [];
  const updater = withVendoredUpdater(new EventEmitter(), ({ NsisUpdater }) => new NsisUpdater(null, { version: "1.0.0", onQuit: (handler) => quitHandlers.push(handler), quit() {} }));
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.autoInstallOnAppQuit = false;
  updater.addQuitHandler();
  assert.equal(quitHandlers.length, 0);
  updater.autoInstallOnAppQuit = true;
  updater.addQuitHandler();
  assert.equal(quitHandlers.length, 1, "the fixture would catch a quit handler if one were added");
});

test("Mac vendor patch fails closed on an unknown upstream shape", () => {
  assert.throws(() => patchMacUpdater("not the pinned MacUpdater"), /one Mac updater site to patch, found 0/);
});
