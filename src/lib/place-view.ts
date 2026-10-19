import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { cloudPlanView, startCloudPlan } from "@/lib/cloud-plan";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Action, Bot, ConfigStatus } from "@/state/store";
import type { LocaleKey } from "@/locales";
import {
  placeRowView, type Place, type PlaceActionId, type PlaceRow, type PlaceTranslate, type PlaceView, type ServerKind,
} from "../../shared/place-view";

export const placeTranslate: PlaceTranslate = (key, params) => t(key as LocaleKey, params);

export interface PlaceSeat {
  server: ServerKind;
  plan: boolean;
  role: "admin" | "user";
}

export function serverKind(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, platform: DesktopCapabilities["host"]["platform"]): ServerKind {
  if (config?.cloudHome) return "my-cloud";
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "linux";
}

export function placeRowViewFor(row: PlaceRow, seat: PlaceSeat, worksOnLabel?: string): PlaceView {
  const read = row.state === "cc-needs-key" && seat.plan && seat.server !== "my-cloud" ? { ...row, state: "cc-on-my-cloud" as const } : row;
  return placeRowView(read, { server: seat.server, role: seat.role, worksOnLabel, translate: placeTranslate, locale: activeLocale() });
}

export function useCloudPlanPaid(): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.laterdog?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => { updated = true; if (active) setAccount(next); });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return Boolean(bridge) && cloudPlanView(account).kind === "paid";
}

export function usePlaceSeat(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, platform: DesktopCapabilities["host"]["platform"]): PlaceSeat {
  const plan = useCloudPlanPaid();
  const ownerOrAdmin = useOwnerOrAdmin();
  return { server: serverKind(config, platform), plan, role: ownerOrAdmin === false ? "user" : "admin" };
}

export function openPlaceAction(
  id: PlaceActionId,
  target: { botId: string; threadId?: string; place?: Place },
  dispatch: (action: Action) => void,
): boolean {
  const appSettings = (section: "general" | "computer") =>
    dispatch({ type: "toggleAppSettings", open: true, section });
  switch (id) {
    case "choose-model": dispatch({ type: "toggleSettings", open: true, section: "model", botId: target.botId }); return true;
    case "change-routine": dispatch({ type: "toggleSettings", open: true, section: "routines", botId: target.botId }); return true;
    case "sign-in": appSettings("general"); return true;
    case "manage-computers": appSettings("computer"); return true;
    case "open-vm-settings": appSettings("computer"); return true;
    case "see-plan": {
      const desktop = window.laterdog?.cloudAccount;
      if (desktop) { void desktop.openDashboard().catch(() => {}); return true; }
      if (window.laterdog?.cloudPlan) { void window.laterdog.cloudPlan.manage().catch(() => {}); return true; }
      appSettings("general");
      return true;
    }
    case "get-cloud":
      void startCloudPlan().catch(() => appSettings("computer"));
      return true;
    case "open-my-cloud": {
      const desktop = window.laterdog?.cloudAccount;
      if (desktop) void desktop.connectHome().catch(() => {});
      else appSettings("general");
      return true;
    }
    case "clear-pin":
      if (!target.threadId) return false;
      dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId, patch: { surface: null } });
      return true;
    case "watch":
    case "open-computer-panel":
    case "allow-computer":
    case "turn-on-browser":
      dispatch({ type: "toggleSettings", open: true, section: "access" });
      return true;
    default:
      return false;
  }
}

export const SIMPLE_PLACE_LABEL = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
} as const satisfies Record<string, LocaleKey>;

export function worksOnSimpleLabel(computer: Bot["computer"], platform: DesktopCapabilities["host"]["platform"]): string {
  if (computer === "local") return t(platform === "darwin" ? "computer.simple.dest.thisMac" : "computer.simple.dest.thisPc");
  return t(SIMPLE_PLACE_LABEL[computer ?? "auto"]);
}
