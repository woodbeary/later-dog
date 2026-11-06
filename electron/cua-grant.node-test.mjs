import assert from "node:assert/strict";
import { test } from "node:test";
import { CUA_RETRY_MS, cuaOffReason, cuaRetriesForUse, cuaStartsAfterGrant } from "./cua-grant.mjs";

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

test("only a Mac starts it; other platforms never do", () => {
  for (const platform of ["win32", "linux", "freebsd", undefined]) {
    assert.equal(cuaStartsAfterGrant({ platform, checklist: granted, connection: waiting }), false, String(platform));
  }
});

test("a dog's request restarts computer control after any failure once both grants are on, at most every 30 seconds", () => {
  for (const connection of [{ mode: "unavailable", reason: "desktop-host-stopped" }, { mode: "unavailable", reason: "embedded host failed: daemon exited with 3" }, null]) {
    assert.equal(cuaRetriesForUse({ platform: "darwin", checklist: granted, connection, now: 100_000 }), true, JSON.stringify(connection));
  }
  assert.equal(cuaRetriesForUse({ platform: "darwin", checklist: granted, connection: null, now: 100_000, lastTry: 100_000 - CUA_RETRY_MS + 1 }), false);
  assert.equal(cuaRetriesForUse({ platform: "darwin", checklist: granted, connection: null, now: 100_000, lastTry: 100_000 - CUA_RETRY_MS }), true);
  assert.equal(cuaRetriesForUse({ platform: "darwin", checklist: { ...granted, screen: "denied" }, connection: null, now: 1 }), false);
  assert.equal(cuaRetriesForUse({ platform: "darwin", checklist: granted, connection: { mode: "embedded", mcpCommand: "/x" }, now: 1 }), false);
  assert.equal(cuaRetriesForUse({ platform: "linux", checklist: granted, connection: null, now: 1 }), false);
});

test("the can't-use-apps message says why", () => {
  assert.equal(cuaOffReason({ mode: "unavailable", reason: "embedded host failed: timed out" }), " (embedded host failed: timed out)");
  assert.equal(cuaOffReason(null), "");
});
