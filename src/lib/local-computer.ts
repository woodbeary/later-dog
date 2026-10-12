import type { Bot, InstanceInfo } from "@/state/store";
import { brand } from "./brand";
import { computerPermissionReason, localPermissionGap, type DesktopPermissionChecklist } from "./desktop-permissions";
import type { MacCuaPermission } from "./mac-cua-permissions";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin" || capabilities.host.platform === "win32";
}

export function localComputerPermissionGap({
  capabilities,
  permissions,
}: {
  capabilities: DesktopCapabilities;
  permissions?: DesktopPermissionChecklist | null;
}): MacCuaPermission[] {
  if (capabilities.host.platform !== "darwin" || capabilities.localComputer.available ||
      capabilities.localComputer.reasonCode === "remote-server") return [];
  return localPermissionGap({ checklist: permissions ?? null, message: capabilities.localComputer.message });
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
  permissions,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
  permissions?: DesktopPermissionChecklist | null;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Cua Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Cua Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  if (capabilities.host.platform === "win32") {
    return "The bundled Cua Driver could not start. Restart later.dog and check Diagnostics if it still fails.";
  }
  const permissionReason = computerPermissionReason(localComputerPermissionGap({ capabilities, permissions }), brand().name);
  if (permissionReason) return permissionReason;
  return "CUA Driver is not ready for local computer control.";
}

export type BoatPanelAction =
  | "cloud-new"
  | "cloud-asleep"
  | "attach-ready-boat"
  | "busy-boat"
  | "team-boat"
  | "show-ready-boat"
  | "show-sleeping-boat"
  | "show-pending-boat"
  | "local"
  | "unconfigured"
  | "auto-unavailable";

const READY_BOAT_STATES = new Set(["idle", "ready", "running"]);

export function isReadyBoatState(state: string | null | undefined): boolean {
  return typeof state === "string" && READY_BOAT_STATES.has(state);
}
const SLEEPING_BOAT_STATES = new Set(["archived", "stopped"]);

export function resolveBoatPanelAction({
  computer,
  configured,
  boatState,
  canUseCloud,
  autoLocal,
  teamComputer = false,
  busy = false,
}: {
  computer: Bot["computer"];
  configured: boolean;
  boatState: string | null;
  canUseCloud: boolean;
  autoLocal: boolean;
  teamComputer?: boolean;
  busy?: boolean;
}): BoatPanelAction {
  if (computer === undefined && teamComputer) return "team-boat";
  const explicitCloud = computer === "cloud";

  if (!configured) {
    if (explicitCloud) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (explicitCloud) {
    if (!canUseCloud) return "auto-unavailable";
    if (boatState && READY_BOAT_STATES.has(boatState)) return "attach-ready-boat";
    if (busy || (boatState && !SLEEPING_BOAT_STATES.has(boatState))) return "busy-boat";
    return boatState ? "cloud-asleep" : "cloud-new";
  }
  if (canUseCloud && boatState) {
    if (READY_BOAT_STATES.has(boatState)) return "show-ready-boat";
    if (SLEEPING_BOAT_STATES.has(boatState)) return "show-sleeping-boat";
    return "show-pending-boat";
  }
  return autoLocal ? "local" : "auto-unavailable";
}

export function busyBoatView(boatState: string | null, busy: boolean): {
  line: "computer.cloud.new" | "computer.cloud.asleep" | "computer.phase.busyBoat" | "computer.phase.starting";
  spinner: boolean;
} {
  if (!boatState) return { line: "computer.cloud.new", spinner: false };
  if (SLEEPING_BOAT_STATES.has(boatState)) return { line: "computer.cloud.asleep", spinner: false };
  return { line: busy ? "computer.phase.busyBoat" : "computer.phase.starting", spinner: true };
}

export function shouldPollCloudPreview(
  {
    computer,
    cloudBackend,
    phase,
    botId,
    resolvedBotId,
    resolvedComputer,
    resolvedCloudBackend,
  }: {
    computer: Bot["computer"];
    cloudBackend: NonNullable<Bot["cloudBackend"]>;
    phase: string;
    botId: string;
    resolvedBotId: string | null;
    resolvedComputer: Bot["computer"] | null;
    resolvedCloudBackend: Bot["cloudBackend"] | null;
  },
): boolean {
  return computer === "cloud"
    && phase === "ready"
    && resolvedBotId === botId
    && resolvedComputer === "cloud"
    && resolvedCloudBackend === cloudBackend;
}

export function persistedComputerSelectionMatches({
  computer,
  cloudBackend,
  persistedBot,
}: {
  computer: Bot["computer"];
  cloudBackend: NonNullable<Bot["cloudBackend"]>;
  persistedBot: Pick<Bot, "computer" | "cloudBackend">;
}): boolean {
  return persistedBot.computer === computer
    && (persistedBot.cloudBackend ?? "box") === cloudBackend;
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}
