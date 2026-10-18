import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { desktopCapabilities } = require("./capabilities.cjs");

test("a remote server's page is told this computer offers no screen, voice or local control", () => {
  const local = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true } });
  const remote = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true });
  assert.equal(local.remote, false);
  assert.equal(local.screenPreview.available, true);
  assert.equal(remote.remote, true);
  assert.deepEqual(remote.screenPreview, { available: false, interaction: "none", reasonCode: "remote-server" });
  assert.equal(remote.dictation.available, false);
  assert.equal(remote.dictation.reasonCode, "remote-server");
  assert.equal(remote.localComputer.available, false);
  assert.equal(remote.localComputer.enabled, false);
  assert.equal(remote.localComputer.reasonCode, "remote-server");
  assert.equal(remote.host.platform, "darwin");
  assert.equal(remote.host.homeDir, "");
  assert.notEqual(local.host.homeDir, "");
});

test("the person's Cloud home page keeps this Mac's speech recognition and nothing else local", () => {
  const home = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true, remoteSpeech: true });
  assert.deepEqual(home.dictation, { available: true, engine: "apple-speech", onDevice: true });
  assert.equal(home.screenPreview.available, false);
  assert.equal(home.localComputer.available, false);
  const windows = desktopCapabilities({ platform: "win32", env: {}, packaged: true, remote: true, remoteSpeech: true });
  assert.equal(windows.dictation.available, false);
  assert.equal(windows.dictation.reasonCode, "unsupported-platform");
});

test("this computer's page learns whether saved sign-ins unlocked; a remote page and an unknown answer get nothing", () => {
  const base = { platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true } };
  assert.equal(desktopCapabilities({ ...base, credentialStore: "unavailable" }).credentialStore, "unavailable");
  assert.equal(desktopCapabilities({ ...base, credentialStore: "ok" }).credentialStore, "ok");
  assert.equal(Object.hasOwn(desktopCapabilities({ ...base }), "credentialStore"), false);
  assert.equal(Object.hasOwn(desktopCapabilities({ ...base, credentialStore: "weird" }), "credentialStore"), false);
  assert.equal(Object.hasOwn(desktopCapabilities({ ...base, credentialStore: "unavailable", remote: true }), "credentialStore"), false);
});

test("the page gets this computer's own name only when main hands it one, which it does for its own window or the person's Cloud", () => {
  const base = { platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true } };
  assert.equal(desktopCapabilities({ ...base, remote: true, computerName: "Jo's MacBook Air" }).host.name, "Jo's MacBook Air");
  assert.equal(desktopCapabilities({ ...base, computerName: "  Studio  " }).host.name, "Studio");
  for (const computerName of [null, undefined, "", "   ", 42]) assert.equal(Object.hasOwn(desktopCapabilities({ ...base, remote: true, computerName }).host, "name"), false);
});
