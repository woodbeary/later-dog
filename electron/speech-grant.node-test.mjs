import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetSpeechGranted, rememberSpeechGranted, speechEverGranted } from "./speech-grant.mjs";

function userDataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "laterdog-speech-grant-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a Mac with no dictation history yet reports nothing granted", () => {
  const { dir, cleanup } = userDataDir();
  try {
    assert.equal(speechEverGranted(dir), false);
  } finally {
    cleanup();
  }
});

test("a successful dictation session is remembered across checks", () => {
  const { dir, cleanup } = userDataDir();
  try {
    rememberSpeechGranted(dir);
    assert.equal(speechEverGranted(dir), true);
    assert.equal(speechEverGranted(dir), true);
  } finally {
    cleanup();
  }
});

test("forgetting clears what was remembered", () => {
  const { dir, cleanup } = userDataDir();
  try {
    rememberSpeechGranted(dir);
    forgetSpeechGranted(dir);
    assert.equal(speechEverGranted(dir), false);
  } finally {
    cleanup();
  }
});

test("a missing user data folder never throws", () => {
  const missing = path.join(tmpdir(), "laterdog-speech-grant-missing", "nested");
  assert.equal(speechEverGranted(missing), false);
  assert.doesNotThrow(() => forgetSpeechGranted(missing));
});
