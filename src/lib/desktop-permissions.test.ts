import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import {
  allGranted,
  checklistHost,
  computerPermissionReason,
  localPermissionGap,
  missingComputerPermissions,
  permissionBridge,
  readChecklist,
  rowActions,
  statusLabel,
  type DesktopPermissionChecklist,
} from "./desktop-permissions";

const checklist = (patch: Partial<DesktopPermissionChecklist> = {}): DesktopPermissionChecklist =>
  ({ microphone: "granted", accessibility: "granted", screen: "granted", ...patch });
const bridge = { status: async () => checklist(), request: async () => checklist(), openSettings: async () => true };

beforeEach(() => setLocale("en"));

describe("where the checklist is read", () => {
  it("finds the bridge only on the desktop app's own page", () => {
    expect(permissionBridge(undefined)).toBeUndefined();
    expect(permissionBridge({})).toBeUndefined();
    // a remote server's reduced bridge, or an older shell: no checklist
    expect(permissionBridge({ permissions: {} })).toBeUndefined();
    expect(permissionBridge({ permissions: { status: bridge.status } })).toBeUndefined();
    expect(permissionBridge({ permissions: bridge })).toBe(bridge);
  });

  it("tells a Mac, another desktop and a browser apart", () => {
    expect(checklistHost(undefined)).toBe("browser");
    expect(checklistHost({ platform: "darwin" })).toBe("browser");
    expect(checklistHost({ platform: "darwin", permissions: bridge })).toBe("mac");
    expect(checklistHost({ platform: "win32", permissions: bridge })).toBe("other");
    expect(checklistHost({ platform: "linux", permissions: bridge })).toBe("other");
  });

  it("reads a bridge answer defensively, never as a grant", () => {
    expect(readChecklist(checklist())).toEqual(checklist());
    expect(readChecklist({ microphone: "denied", accessibility: "notDetermined" })).toEqual({ microphone: "denied", accessibility: "notDetermined", screen: "unavailable" });
    expect(readChecklist({ screen: "yes", microphone: 1 })).toEqual({ microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" });
    expect(readChecklist(null)).toEqual({ microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" });
  });
});

describe("what This PC is missing", () => {
  it("names the computer-control grants not yet given, in the rows' order", () => {
    expect(missingComputerPermissions(checklist())).toEqual([]);
    expect(missingComputerPermissions(checklist({ microphone: "denied" }))).toEqual([]);
    expect(missingComputerPermissions(checklist({ screen: "notDetermined" }))).toEqual(["screen"]);
    expect(missingComputerPermissions(checklist({ accessibility: "denied", screen: "denied" }))).toEqual(["accessibility", "screen"]);
    // no answer yet is not a diagnosis
    expect(missingComputerPermissions(null)).toEqual([]);
    expect(allGranted(checklist())).toBe(true);
    expect(allGranted(checklist({ screen: "denied" }))).toBe(false);
    expect(allGranted(null)).toBe(false);
  });

  it("prefers the live checklist, and falls back to what the driver recorded", () => {
    const recorded = "Screen Recording and Accessibility required; grant access in System Settings and restart later.dog";
    expect(localPermissionGap({ checklist: checklist({ screen: "denied" }), message: recorded })).toEqual(["screen"]);
    expect(localPermissionGap({ checklist: checklist(), message: recorded })).toEqual([]);
    expect(localPermissionGap({ checklist: null, message: recorded })).toEqual(["accessibility", "screen"]);
    expect(localPermissionGap({ checklist: null, message: "Screen Recording required" })).toEqual(["screen"]);
    expect(localPermissionGap({ checklist: null, message: undefined })).toEqual([]);
  });

  it("words the Not ready line with the grant and where to give it", () => {
    expect(computerPermissionReason([], "later.dog")).toBeNull();
    expect(computerPermissionReason(["accessibility"], "later.dog")).toBe("Accessibility isn't allowed for later.dog yet. Allow it in Settings → Computers → Permissions.");
    expect(computerPermissionReason(["screen"], "later.dog")).toBe("Screen Recording isn't allowed for later.dog yet. Allow it in Settings → Computers → Permissions.");
    expect(computerPermissionReason(["accessibility", "screen"], "later.dog")).toBe("Accessibility and Screen Recording aren't allowed for later.dog yet. Allow them in Settings → Computers → Permissions.");
  });
});

describe("what a row says and offers", () => {
  it("words the pill for the place it is read", () => {
    expect(statusLabel("granted", "mac")).toBe("Allowed");
    expect(statusLabel("denied", "mac")).toBe("Not allowed");
    expect(statusLabel("notDetermined", "mac")).toBe("Not asked yet");
    expect(statusLabel(null, "mac")).toBe("Checking…");
    expect(statusLabel("unavailable", "mac")).toBe("Not needed on this computer");
    // off a Mac the status is always unavailable; the place decides the words
    expect(statusLabel("unavailable", "browser")).toBe("Available in the desktop app");
    expect(statusLabel("unavailable", "other")).toBe("Not needed on this computer");
  });

  it("offers Enable where macOS will prompt and System Settings where it will not", () => {
    const none = { enable: false, settings: false, relaunchNote: false, staleHint: false };
    // the microphone: one prompt, then System Settings
    expect(rowActions("microphone", "notDetermined", "mac")).toEqual({ enable: true, settings: false, relaunchNote: false, staleHint: false });
    expect(rowActions("microphone", "denied", "mac")).toEqual({ enable: false, settings: true, relaunchNote: false, staleHint: false });
    // Accessibility's dialog shows on every ask, and "denied" also means never asked
    expect(rowActions("accessibility", "denied", "mac")).toEqual({ enable: true, settings: false, relaunchNote: false, staleHint: true });
    // Screen Recording: a real capture prompts once; the status is cached, so the way back stays visible
    expect(rowActions("screen", "notDetermined", "mac")).toEqual({ enable: true, settings: false, relaunchNote: true, staleHint: false });
    expect(rowActions("screen", "denied", "mac")).toEqual({ enable: false, settings: true, relaunchNote: true, staleHint: true });
    for (const permission of ["microphone", "accessibility", "screen"] as const) {
      expect(rowActions(permission, "granted", "mac")).toEqual(none);
      expect(rowActions(permission, "unavailable", "mac")).toEqual(none);
      expect(rowActions(permission, null, "mac")).toEqual(none);
      // nothing can be asked without the bridge, or off a Mac
      expect(rowActions(permission, "denied", "browser")).toEqual(none);
      expect(rowActions(permission, "notDetermined", "other")).toEqual(none);
    }
  });
});
