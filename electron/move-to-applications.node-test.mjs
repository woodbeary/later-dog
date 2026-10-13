import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bundlePathOf, offerMoveToApplications, runningFromDownload } from "./move-to-applications.mjs";

const DMG = "/Volumes/later.dog/later.dog.app/Contents/MacOS/later.dog";
const TRANSLOCATED = "/private/var/folders/xy/T/AppTranslocation/2F1C/d/later.dog.app/Contents/MacOS/later.dog";
const DOWNLOADS = "/Users/ada/Downloads/later.dog.app/Contents/MacOS/later.dog";
const EXTERNAL_DRIVE = "/Volumes/Work/Tools/later.dog.app/Contents/MacOS/later.dog";
const APPLICATIONS = "/Applications/later.dog.app/Contents/MacOS/later.dog";

const writableExcept = (...readOnly) => (dir) => !readOnly.includes(dir);
const onDiskImage = { platform: "darwin", execPath: DMG, writable: writableExcept("/Volumes/later.dog") };

function fakeApp({ packaged = true, inApplications = false, move = () => true } = {}) {
  const moves = [];
  return {
    moves,
    isPackaged: packaged,
    isInApplicationsFolder: () => inApplications,
    moveToApplicationsFolder: () => {
      moves.push(true);
      return move();
    },
  };
}

function fakeDialog(responses = [0]) {
  const shown = [];
  return {
    shown,
    async showMessageBox(options) {
      shown.push(options);
      return { response: responses[shown.length - 1] ?? 0 };
    },
  };
}

function fakeLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  return log;
}

test("the app bundle is found from the running executable", () => {
  assert.equal(bundlePathOf(DMG), "/Volumes/later.dog/later.dog.app");
  assert.equal(bundlePathOf(TRANSLOCATED), "/private/var/folders/xy/T/AppTranslocation/2F1C/d/later.dog.app");
  assert.equal(bundlePathOf("/usr/local/bin/node"), null);
  assert.equal(bundlePathOf(undefined), null);
});

test("only a packaged Mac app running from the disk image or a quarantined download is offered the move", () => {
  const app = fakeApp();
  assert.equal(runningFromDownload({ app, ...onDiskImage }), true);
  assert.equal(runningFromDownload({ app, platform: "darwin", execPath: TRANSLOCATED, writable: () => true }), true);
  assert.equal(runningFromDownload({ app, platform: "darwin", execPath: DOWNLOADS, writable: () => true }), false);
  assert.equal(runningFromDownload({ app, platform: "darwin", execPath: EXTERNAL_DRIVE, writable: () => true }), false);
  assert.equal(runningFromDownload({ app: fakeApp({ inApplications: true }), platform: "darwin", execPath: APPLICATIONS, writable: () => false }), false);
  assert.equal(runningFromDownload({ app: fakeApp({ packaged: false }), ...onDiskImage }), false);
  const elsewhere = { isPackaged: true, isInApplicationsFolder: () => assert.fail("macOS only") };
  assert.equal(runningFromDownload({ app: elsewhere, platform: "win32", execPath: "C:\\later.dog\\later.dog.exe" }), false);
  assert.equal(runningFromDownload({ app: elsewhere, platform: "linux", execPath: "/tmp/.mount_later/later.dog" }), false);
});

test("a folder the app can't write beside counts as read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "laterdog-move-"));
  const folder = join(root, "download");
  const execPath = join(folder, "later.dog.app", "Contents", "MacOS", "later.dog");
  mkdirSync(join(folder, "later.dog.app", "Contents", "MacOS"), { recursive: true });
  try {
    assert.equal(runningFromDownload({ app: fakeApp(), platform: "darwin", execPath }), false);
    chmodSync(folder, 0o555);
    assert.equal(runningFromDownload({ app: fakeApp(), platform: "darwin", execPath }), true);
  } finally {
    chmodSync(folder, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test("saying yes moves the app and tells startup to stop, because it relaunches from Applications", async () => {
  const app = fakeApp();
  const dialog = fakeDialog([0]);
  const log = fakeLog();
  assert.equal(await offerMoveToApplications({ app, dialog, log, ...onDiskImage }), true);
  assert.equal(app.moves.length, 1);
  assert.equal(dialog.shown.length, 1);
  assert.equal(dialog.shown[0].message, "Move later.dog to Applications?");
  assert.deepEqual(dialog.shown[0].buttons, ["Move to Applications", "Not Now"]);
  assert.equal(dialog.shown[0].defaultId, 0);
  assert.equal(dialog.shown[0].cancelId, 1);
  assert.deepEqual(log.lines, ["moved later.dog to Applications; relaunching from there"]);
});

test("Not Now, or cancelling the password prompt, keeps starting from the download", async () => {
  const notNow = fakeApp();
  assert.equal(await offerMoveToApplications({ app: notNow, dialog: fakeDialog([1]), log: fakeLog(), ...onDiskImage }), false);
  assert.equal(notNow.moves.length, 0);
  const cancelled = fakeApp({ move: () => false });
  const log = fakeLog();
  assert.equal(await offerMoveToApplications({ app: cancelled, dialog: fakeDialog([0]), log, ...onDiskImage }), false);
  assert.equal(cancelled.moves.length, 1);
  assert.deepEqual(log.lines, ["the move to Applications was cancelled"]);
});

test("a failed copy explains how to finish by hand, then keeps starting", async () => {
  const app = fakeApp({ move: () => { throw new Error("Failed to copy current bundle to the applications folder"); } });
  const dialog = fakeDialog([0, 0]);
  const log = fakeLog();
  assert.equal(await offerMoveToApplications({ app, dialog, log, ...onDiskImage }), false);
  assert.equal(dialog.shown.length, 2);
  assert.equal(dialog.shown[1].type, "warning");
  assert.equal(dialog.shown[1].message, "later.dog couldn't move itself");
  assert.match(dialog.shown[1].detail, /Drag later\.dog into Applications/);
  assert.deepEqual(log.lines, ["moving later.dog to Applications failed: Failed to copy current bundle to the applications folder"]);
});

test("nothing is asked from Applications, a writable folder, or a development run", async () => {
  for (const [app, options] of [
    [fakeApp({ inApplications: true }), { platform: "darwin", execPath: APPLICATIONS, writable: () => true }],
    [fakeApp(), { platform: "darwin", execPath: DOWNLOADS, writable: () => true }],
    [fakeApp({ packaged: false }), onDiskImage],
  ]) {
    const dialog = fakeDialog();
    assert.equal(await offerMoveToApplications({ app, dialog, log: fakeLog(), ...options }), false);
    assert.equal(dialog.shown.length, 0);
    assert.equal(app.moves.length, 0);
  }
});
