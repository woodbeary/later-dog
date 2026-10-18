import { t } from "./i18n";
import { missingMacCuaPermissions, type MacCuaPermission } from "./mac-cua-permissions";

export type DesktopPermission = "microphone" | "accessibility" | "screen";

export type DesktopPermissionStatus = "granted" | "denied" | "notDetermined" | "unavailable";

export type DesktopPermissionChecklist = Record<DesktopPermission, DesktopPermissionStatus>;

export interface DesktopPermissionsBridge {
  status(): Promise<DesktopPermissionChecklist>;
  request(permission: DesktopPermission): Promise<DesktopPermissionChecklist>;
  openSettings(permission: DesktopPermission): Promise<boolean>;
}

export const DESKTOP_PERMISSIONS: readonly DesktopPermission[] = ["microphone", "accessibility", "screen"];

export const COMPUTER_PERMISSIONS: readonly MacCuaPermission[] = ["accessibility", "screen"];

export const UNAVAILABLE_CHECKLIST: DesktopPermissionChecklist = Object.freeze({
  microphone: "unavailable",
  accessibility: "unavailable",
  screen: "unavailable",
}) as DesktopPermissionChecklist;

type PermissionHost = { permissions?: Partial<DesktopPermissionsBridge>; cloudPermissions?: Partial<DesktopPermissionsBridge> };

export function permissionBridge(laterdog: PermissionHost | undefined): DesktopPermissionsBridge | undefined {
  const bridge = laterdog?.permissions ?? laterdog?.cloudPermissions;
  return bridge && typeof bridge.status === "function" && typeof bridge.request === "function" && typeof bridge.openSettings === "function"
    ? (bridge as DesktopPermissionsBridge)
    : undefined;
}

export type ChecklistHost =
  | "mac"
  | "other"
  | "browser";

export function checklistHost(
  laterdog: (PermissionHost & { platform?: string }) | undefined,
): ChecklistHost {
  if (!permissionBridge(laterdog)) return "browser";
  return laterdog?.platform === "darwin" ? "mac" : "other";
}

const STATUSES: ReadonlySet<string> = new Set(["granted", "denied", "notDetermined", "unavailable"]);

export function readChecklist(value: unknown): DesktopPermissionChecklist {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const status = (permission: DesktopPermission): DesktopPermissionStatus => {
    const raw = record[permission];
    return typeof raw === "string" && STATUSES.has(raw) ? (raw as DesktopPermissionStatus) : "unavailable";
  };
  return { microphone: status("microphone"), accessibility: status("accessibility"), screen: status("screen") };
}

export function allGranted(checklist: DesktopPermissionChecklist | null | undefined): boolean {
  return Boolean(checklist) && DESKTOP_PERMISSIONS.every((permission) => checklist![permission] === "granted");
}

export function missingComputerPermissions(checklist: DesktopPermissionChecklist | null | undefined): MacCuaPermission[] {
  if (!checklist) return [];
  return COMPUTER_PERMISSIONS.filter((permission) => checklist[permission] === "denied" || checklist[permission] === "notDetermined");
}

export function localPermissionGap({
  checklist,
  message,
}: {
  checklist: DesktopPermissionChecklist | null | undefined;
  message: string | undefined;
}): MacCuaPermission[] {
  if (checklist) return missingComputerPermissions(checklist);
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

export function computerPermissionReason(missing: readonly MacCuaPermission[], app: string): string | null {
  if (!missing.length) return null;
  if (missing.length > 1) return t("computer.local.missingBoth", { app });
  return t("computer.local.missingOne", { permission: permissionName(missing[0]!), app });
}

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
  enable: boolean;
  settings: boolean;
  relaunchNote: boolean;
  staleHint: boolean;
}

export function rowActions(permission: DesktopPermission, status: DesktopPermissionStatus | null, host: ChecklistHost): RowActions {
  if (host !== "mac" || status === null || status === "granted" || status === "unavailable") {
    return { enable: false, settings: false, relaunchNote: false, staleHint: false };
  }
  const enable = status === "notDetermined" || permission === "accessibility";
  return {
    enable,
    settings: !enable,
    relaunchNote: permission === "screen",
    staleHint: status === "denied" && permission !== "microphone",
  };
}
