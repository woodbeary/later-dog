import { t } from "./i18n";
import { missingMacCuaPermissions, type MacCuaPermission } from "./mac-cua-permissions";

export type DesktopPermission = "microphone" | "accessibility" | "screen";

/** What macOS reports to the app's process right now. `unavailable`: not a
 * macOS grant here (another platform), or a shell too old to say. */
export type DesktopPermissionStatus = "granted" | "denied" | "notDetermined" | "unavailable";

export type DesktopPermissionChecklist = Record<DesktopPermission, DesktopPermissionStatus>;

/** The bridge's three calls (electron/preload.cjs `permissions`). */
export interface DesktopPermissionsBridge {
  status(): Promise<DesktopPermissionChecklist>;
  /** Shows that grant's real system prompt, then answers with the whole checklist. */
  request(permission: DesktopPermission): Promise<DesktopPermissionChecklist>;
  /** Opens System Settings on that grant's privacy pane. */
  openSettings(permission: DesktopPermission): Promise<boolean>;
}

/** The rows, in the order every surface draws them. */
export const DESKTOP_PERMISSIONS: readonly DesktopPermission[] = ["microphone", "accessibility", "screen"];

/** The grants computer control needs; the microphone is dictation's. */
export const COMPUTER_PERMISSIONS: readonly MacCuaPermission[] = ["accessibility", "screen"];

export const UNAVAILABLE_CHECKLIST: DesktopPermissionChecklist = Object.freeze({
  microphone: "unavailable",
  accessibility: "unavailable",
  screen: "unavailable",
}) as DesktopPermissionChecklist;

/** The bridge, where this window has it: the desktop app's own page. A
 * browser has none; a remote server's page gets the reduced bridge without it. */
export function permissionBridge(
  laterdog: { permissions?: Partial<DesktopPermissionsBridge> } | undefined,
): DesktopPermissionsBridge | undefined {
  const bridge = laterdog?.permissions;
  return bridge && typeof bridge.status === "function" && typeof bridge.request === "function" && typeof bridge.openSettings === "function"
    ? (bridge as DesktopPermissionsBridge)
    : undefined;
}

/** What the rows can do here. */
export type ChecklistHost =
  /** macOS with the bridge: statuses are live and each row can ask. */
  | "mac"
  /** the desktop app on Windows or Linux: these are macOS switches, none to flip */
  | "other"
  /** no bridge (a browser, the preview page): the desktop app has them */
  | "browser";

export function checklistHost(
  laterdog: { platform?: string; permissions?: Partial<DesktopPermissionsBridge> } | undefined,
): ChecklistHost {
  if (!permissionBridge(laterdog)) return "browser";
  return laterdog?.platform === "darwin" ? "mac" : "other";
}

const STATUSES: ReadonlySet<string> = new Set(["granted", "denied", "notDetermined", "unavailable"]);

/** Read a bridge answer defensively: a field an older shell did not send, or
 * a word this build does not know, reads as unavailable rather than as a grant. */
export function readChecklist(value: unknown): DesktopPermissionChecklist {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const status = (permission: DesktopPermission): DesktopPermissionStatus => {
    const raw = record[permission];
    return typeof raw === "string" && STATUSES.has(raw) ? (raw as DesktopPermissionStatus) : "unavailable";
  };
  return { microphone: status("microphone"), accessibility: status("accessibility"), screen: status("screen") };
}

/** Every grant a Mac can give is given. Null (no answer yet) is not. */
export function allGranted(checklist: DesktopPermissionChecklist | null | undefined): boolean {
  return Boolean(checklist) && DESKTOP_PERMISSIONS.every((permission) => checklist![permission] === "granted");
}

/** The computer-control grants not yet given. No answer names none: a
 * missing answer is not a diagnosis. */
export function missingComputerPermissions(checklist: DesktopPermissionChecklist | null | undefined): MacCuaPermission[] {
  if (!checklist) return [];
  return COMPUTER_PERMISSIONS.filter((permission) => checklist[permission] === "denied" || checklist[permission] === "notDetermined");
}

/** The grants This PC still needs: the live checklist once the bridge has
 * answered, else what the driver recorded when it last tried to start
 * (capabilities.localComputer.message, read by mac-cua-permissions). */
export function localPermissionGap({
  checklist,
  message,
}: {
  checklist: DesktopPermissionChecklist | null | undefined;
  message: string | undefined;
}): MacCuaPermission[] {
  if (checklist) return missingComputerPermissions(checklist);
  // the driver names them in its own order; the rows' order reads better
  const recorded = new Set(missingMacCuaPermissions(message));
  return COMPUTER_PERMISSIONS.filter((permission) => recorded.has(permission));
}

export function permissionName(permission: DesktopPermission): string {
  switch (permission) {
    case "microphone":
      return t("onboarding.perms.mic");
    case "accessibility":
      return t("permissions.accessibility");
    case "screen":
      return t("permissions.screen");
  }
}

/** The "This PC — Not ready" line when a grant is missing, else null. */
export function computerPermissionReason(missing: readonly MacCuaPermission[], app: string): string | null {
  if (!missing.length) return null;
  if (missing.length > 1) return t("computer.local.missingBoth", { app });
  return t("computer.local.missingOne", { permission: permissionName(missing[0]!), app });
}

/** A row's status pill, in words. Off a Mac the status is always
 * unavailable, and where it is read decides what that means. */
export function statusLabel(status: DesktopPermissionStatus | null, host: ChecklistHost): string {
  if (host === "browser") return t("permissions.status.desktopOnly");
  if (host === "other") return t("permissions.status.notNeeded");
  switch (status) {
    case "granted":
      return t("permissions.status.granted");
    case "denied":
      return t("permissions.status.denied");
    case "notDetermined":
      return t("permissions.status.notDetermined");
    case "unavailable":
      return t("permissions.status.notNeeded");
    default:
      return t("permissions.status.checking");
  }
}

export interface RowActions {
  /** Enable: shows the real system prompt. */
  enable: boolean;
  /** Open System Settings: the way back macOS leaves after a denial. */
  settings: boolean;
  /** The row says a Screen Recording grant shows after a relaunch. */
  relaunchNote: boolean;
  /** The row says a grant that looks on in System Settings may belong to an earlier build (unsigned builds). */
  staleHint: boolean;
}

/** What a row offers. Only a Mac with the bridge can ask; a grant macOS will
 * not prompt for again (a denied microphone or screen) gets System Settings
 * instead, while Accessibility's dialog shows on every ask, and its "denied"
 * also covers "never asked" (mac-permissions.mjs). Screen Recording's status
 * is cached per process, so its row keeps the Settings link and the relaunch
 * note until macOS reports the grant. */
export function rowActions(permission: DesktopPermission, status: DesktopPermissionStatus | null, host: ChecklistHost): RowActions {
  if (host !== "mac" || status === null || status === "granted" || status === "unavailable") {
    return { enable: false, settings: false, relaunchNote: false, staleHint: false };
  }
  // One action per row. Accessibility's own prompt adds later.dog to the list and opens the pane, so Enable is enough;
  // the others prompt only while macOS has not asked, then the way back is System Settings.
  const enable = status === "notDetermined" || permission === "accessibility";
  return {
    enable,
    settings: !enable,
    relaunchNote: permission === "screen",
    // An unsigned build is a new app to macOS: a switch turned on for an earlier build stays on in System Settings
    // and does not apply to this one until it is turned off and on again.
    staleHint: status === "denied" && permission !== "microphone",
  };
}
