import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { cloudPlanView } from "@/lib/cloud-plan";
import { engineSignedOut } from "@/lib/failed-turn";
import { browserAvailable, builtInBrowserEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Action, Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import type { LocaleKey } from "@/locales";
import {
  placeRowView, placeView, type Place, type PlaceActionId, type PlaceFacts, type PlaceRow, type PlaceTranslate, type PlaceView, type ServerKind,
} from "../../shared/place-view";
import { canUseMcpServer } from "../../shared/tool-scope";

/** The catalog's words for a place key (src/locales/en.json mirrors it). */
export const placeTranslate: PlaceTranslate = (key, params) => t(key as LocaleKey, params);

/** What the app knows about where it runs and who is looking. */
export interface PlaceSeat {
  server: ServerKind;
  /** This desktop is signed in to a paid later.dog Cloud plan. */
  plan: boolean;
  role: "admin" | "user";
}

export function serverKind(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, platform: DesktopCapabilities["host"]["platform"]): ServerKind {
  if (config?.cloudHome) return "my-cloud";
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "linux";
}

/** The engine facts a place reads, from the bot's engine. */
function engineFacts(instance: InstanceInfo | undefined, model: string | undefined): PlaceFacts["engine"] {
  const label = instance?.models?.options?.find((option) => option.id === model)?.label;
  return {
    name: instance?.displayName || instance?.driverKind || model || "",
    model: label || model || instance?.displayName || "",
    computer: instance?.capabilities?.computerMcp === true,
    browser: instance?.capabilities?.browserMcp === true,
    signedIn: !engineSignedOut(instance),
  };
}

/** Every fact of a bot's place but the place itself and its live state. */
export function placeFacts(input: {
  bot: Pick<Bot, "name" | "modelSelection" | "toolScope" | "cloudBackend" | "browser">;
  place: PlaceFacts["place"];
  seat: PlaceSeat;
  config: (FeatureFlagConfig & Pick<ConfigStatus, "box">) | null | undefined;
  instances: InstanceInfo[];
  local?: PlaceFacts["local"];
  computer?: PlaceFacts["computer"];
  teamComputer?: string;
}): PlaceFacts {
  const { bot, config, seat } = input;
  const instance = input.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  return {
    place: input.place,
    server: seat.server,
    bot: bot.name,
    plan: seat.plan,
    boat: config?.box?.configured ? (config.box.included ? "included" : "own-key") : "none",
    backend: bot.cloudBackend === "vps" ? "vps" : "box",
    engine: engineFacts(instance, bot.modelSelection.model),
    toolsAllowComputer: canUseMcpServer(bot.toolScope, "computer"),
    browserOn: builtInBrowserEnabled(config) && (browserAvailable(config) || config?.browserEngine?.installable === true) && bot.browser !== false,
    role: seat.role,
    ...(input.local ? { local: input.local } : {}),
    ...(input.computer ? { computer: input.computer } : {}),
    ...(input.teamComputer ? { teamComputer: input.teamComputer } : {}),
  };
}

/** One place's view, in the person's language. */
export function placeViewFor(facts: PlaceFacts): PlaceView {
  return placeView(facts, { translate: placeTranslate, locale: activeLocale() });
}

/** A stored failed-turn row's place, worded for this reader. A desktop on a
 * paid plan reads "needs a Boat key" as what it is for it: the plan's cloud
 * computers work on My Cloud. */
export function placeRowViewFor(row: PlaceRow, seat: PlaceSeat, worksOnLabel?: string): PlaceView {
  const read = row.state === "cc-needs-key" && seat.plan && seat.server !== "my-cloud" ? { ...row, state: "cc-on-my-cloud" as const } : row;
  return placeRowView(read, { server: seat.server, role: seat.role, worksOnLabel, translate: placeTranslate, locale: activeLocale() });
}

/** Whether a place can't be picked at all: no setting here makes it work. */
export function placeBlocked(view: PlaceView): boolean {
  return view.state === "cc-cannot" || view.state === "cc-on-my-cloud" || view.state === "browser-off" || view.state === "browser-cannot"
    || view.state === "vm-cannot" || view.state === "local-unavailable";
}

/** Whether a place's state is a problem to name on its card, not its usual description. */
export function placeHasIssue(view: PlaceView): boolean {
  return placeBlocked(view) || view.state === "cc-tools-off" || view.state === "cc-sign-in" || view.state === "cc-needs-key"
    || view.state === "cc-unavailable";
}

/** The desktop bridge's plan: paid or not. Reads the native snapshot only;
 * never signs in or refreshes. False without a bridge (a browser, a server's
 * page). */
export function useCloudPlanPaid(): boolean {
  const bridge = typeof window === "undefined" || window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudAccount;
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

/** Where this app runs and who is looking: one hook for every place control. */
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
    case "add-boat-key": appSettings("computer"); return true;
    case "open-vm-settings": appSettings("computer"); return true;
    case "open-team-map": dispatch({ type: "showTeamMap" }); return true;
    case "see-plan": {
      const desktop = window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudAccount;
      if (desktop) { void desktop.openDashboard().catch(() => {}); return true; }
      if (window.laterdog?.cloudPlan) { void window.laterdog.cloudPlan.manage().catch(() => {}); return true; }
      appSettings("general");
      return true;
    }
    case "open-my-cloud": {
      const desktop = window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudAccount;
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
      dispatch({ type: "toggleComputer", open: true });
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
