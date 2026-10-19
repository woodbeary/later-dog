import { parseAppLink, type AppLink } from "../../shared/app-link";
import type { AppSettingsSection } from "@/state/store";

export interface AppLinkRoster {
  bots: ReadonlyArray<{ id: string }>;
  groups: ReadonlyArray<{ id: string; dm?: boolean }>;
}

export type AppLinkStep =
  | { kind: "select"; id: string }
  | { kind: "settings"; section: AppSettingsSection }
  | { kind: "notFound" };

export function appLinkFromBridge(url: unknown): AppLink | null {
  const parsed = parseAppLink(url);
  return parsed.ok ? parsed.link : null;
}

export function appLinkStep(link: AppLink, roster: AppLinkRoster): AppLinkStep {
  if (link.kind === "settings") return { kind: "settings", section: link.section ?? "general" };
  const known = roster.bots.some((bot) => bot.id === link.id) || roster.groups.some((group) => group.id === link.id && !group.dm);
  return known ? { kind: "select", id: link.id } : { kind: "notFound" };
}
