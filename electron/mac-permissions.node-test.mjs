import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DESKTOP_PERMISSIONS, permissionChecklist, permissionStatus, requestPermission } from "./mac-permissions.mjs";

/** A fake systemPreferences/desktopCapturer pair that records every call. */
function macHost(state = {}) {
  const calls = [];
  const tcc = { microphone: "not-determined", screen: "not-determined", accessibility: false, ...state };
  return {
    calls,
    tcc,
    host: {
      platform: "darwin",
      systemPreferences: {
        getMediaAccessStatus: (mediaType) => {
          calls.push(["getMediaAccessStatus", mediaType]);
          return tcc[mediaType];
        },
        isTrustedAccessibilityClient: (prompt) => {
          calls.push(["isTrustedAccessibilityClient", prompt]);
          return tcc.accessibility;
        },
        askForMediaAccess: async (mediaType) => {
          calls.push(["askForMediaAccess", mediaType]);
          tcc[mediaType] = "granted";
          return true;
        },
      },
      desktopCapturer: {
        getSources: async (options) => {
          calls.push(["getSources", options]);
          tcc.screen = "granted";
          return [];
        },
      },
    },
  };
}

test("macOS TCC words map onto the checklist's four statuses", () => {
  assert.equal(permissionStatus("granted"), "granted");
  assert.equal(permissionStatus("denied"), "denied");
  assert.equal(permissionStatus("restricted"), "denied");
  assert.equal(permissionStatus("not-determined"), "notDetermined");
  assert.equal(permissionStatus("unknown"), "unavailable");
  assert.equal(permissionStatus(undefined), "unavailable");
});

test("the checklist reads each grant live and never prompts", () => {
  const { host, calls } = macHost({ microphone: "granted", screen: "denied", accessibility: true });
  assert.deepEqual(permissionChecklist(host), { microphone: "granted", accessibility: "granted", screen: "denied" });
  // Accessibility is read with prompt=false: a status read must not pop a dialog.
  assert.deepEqual(calls, [
    ["getMediaAccessStatus", "microphone"],
    ["isTrustedAccessibilityClient", false],
    ["getMediaAccessStatus", "screen"],
  ]);
  // An app macOS never asked about reads as denied: AXIsProcessTrusted has no third answer.
  assert.equal(permissionChecklist(macHost({ accessibility: false }).host).accessibility, "denied");
});

test("anywhere but macOS there is nothing to ask for", async () => {
  for (const platform of ["win32", "linux", "other"]) {
    const unavailable = { microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" };
    assert.deepEqual(permissionChecklist({ platform, systemPreferences: {} }), unavailable);
    assert.deepEqual(await requestPermission("screen", { platform }), unavailable);
  }
  // A macOS build whose Electron lacks a surface fails closed, not thrown.
  assert.deepEqual(permissionChecklist({ platform: "darwin", systemPreferences: {} }),
    { microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" });
});

test("a request shows that grant's real prompt and answers with the whole checklist", async () => {
  const mic = macHost();
  assert.deepEqual(await requestPermission("microphone", mic.host), { microphone: "granted", accessibility: "denied", screen: "notDetermined" });
  assert.deepEqual(mic.calls[0], ["askForMediaAccess", "microphone"]);

  const accessibility = macHost();
  await requestPermission("accessibility", accessibility.host);
  assert.deepEqual(accessibility.calls[0], ["isTrustedAccessibilityClient", true]);

  // Screen Recording's only prompt is a real capture: one 1×1 thumbnail, discarded.
  const screen = macHost();
  assert.deepEqual(await requestPermission("screen", screen.host), { microphone: "notDetermined", accessibility: "denied", screen: "granted" });
  assert.deepEqual(screen.calls[0], ["getSources", { types: ["screen"], thumbnailSize: { width: 1, height: 1 } }]);
});

test("a prompt that cannot be shown still answers with the current statuses", async () => {
  const { host } = macHost({ microphone: "denied" });
  host.systemPreferences.askForMediaAccess = async () => { throw new Error("no TCC"); };
  assert.deepEqual(await requestPermission("microphone", host), { microphone: "denied", accessibility: "denied", screen: "notDetermined" });
});

test("only the three known grants can be requested", async () => {
  assert.deepEqual([...DESKTOP_PERMISSIONS], ["microphone", "accessibility", "screen"]);
  for (const bad of ["camera", "__proto__", "constructor", 1, null, undefined, {}]) {
    await assert.rejects(requestPermission(bad, macHost().host), /Unknown permission/);
  }
});

test("the app wires the checklist to local-only channels and the same privacy panes", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /import \{ permissionChecklist, requestPermission \} from "\.\/mac-permissions\.mjs";/);
  assert.match(main, /const macPermissionHost = \(\) => \(\{ platform: process\.platform, systemPreferences, desktopCapturer \}\);/);
  assert.match(main, /ipcMain\.handle\("perm:checklist", localOnly\("perm:checklist", \(\) => permissionChecklist\(macPermissionHost\(\)\)\)\);/);
  assert.match(main, /ipcMain\.handle\("perm:request", localOnly\("perm:request", \(_event, permission\) => requestPermission\(permission, macPermissionHost\(\)\)\)\);/);
  // The bridge names grants "microphone"; the pane map knows that name.
  assert.match(main, /microphone: "Privacy_Microphone",/);
  assert.match(main, /accessibility: "Privacy_Accessibility",/);
  assert.match(main, /screen: "Privacy_ScreenCapture",/);
});
