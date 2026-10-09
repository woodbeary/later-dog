import assert from "node:assert/strict";
import { test } from "node:test";
import { cuaStartsAfterGrant } from "./cua-grant.mjs";

const granted = { microphone: "denied", accessibility: "granted", screen: "granted" };
const waiting = { mode: "unavailable", reason: "embedded host failed: Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac" };

test("a daemon that waited for the grants starts once this Mac gives both", () => {
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: granted, connection: waiting }), true);
  for (const reason of [
    "Accessibility required; later.dog asks for them when a dog first uses this Mac",
    "embedded host failed: Screen Recording required; later.dog asks for them when a dog first uses this Mac; standalone launch failed: open exited with 1",
    "Screen Recording and Accessibility required; grant access in System Settings and restart later.dog",
  ]) {
    assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: granted, connection: { mode: "unavailable", reason } }), true, reason);
  }
});

test("one grant, no answer yet, or the microphone alone is not enough", () => {
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: { ...granted, screen: "denied" }, connection: waiting }), false);
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: { ...granted, accessibility: "denied" }, connection: waiting }), false);
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: { ...granted, screen: "notDetermined" }, connection: waiting }), false);
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: null, connection: waiting }), false);
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: undefined, connection: waiting }), false);
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: { microphone: "granted" }, connection: waiting }), false);
});

test("a daemon that is running, was stopped, never tried, or failed for another reason stays as it is", () => {
  for (const connection of [
    { mode: "embedded", socketPath: "/tmp/x.sock" },
    { mode: "standalone", socketPath: "/tmp/x.sock" },
    { mode: "unavailable", reason: "desktop-host-stopped" },
    { mode: "unavailable", reason: "not-started" },
    { mode: "unavailable", reason: "unsupported-platform" },
    { mode: "unavailable", reason: "cua-driver binary not found" },
    { mode: "unavailable", reason: "embedded host failed: daemon exited with 3; standalone launch failed: open exited with 1" },
    { mode: "unavailable", reason: "Accessibility requires a newer macOS" },
    { mode: "unavailable", reason: 42 },
    { mode: "unavailable" },
    null,
    undefined,
  ]) {
    assert.equal(cuaStartsAfterGrant({ platform: "darwin", checklist: granted, connection }), false, JSON.stringify(connection));
  }
});

test("only this Mac's own page starts it; other platforms and a remote server's page never do", () => {
  assert.equal(cuaStartsAfterGrant({ platform: "darwin", remote: true, checklist: granted, connection: waiting }), false);
  for (const platform of ["win32", "linux", "freebsd", undefined]) {
    assert.equal(cuaStartsAfterGrant({ platform, checklist: granted, connection: waiting }), false, String(platform));
  }
});
