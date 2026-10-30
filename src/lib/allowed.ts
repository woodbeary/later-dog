import type { CommandAllowlistRule } from "../../shared/command-allowlist";
import { vaultAllowSite } from "../../shared/vault";

export type AllowedItem =
  | { kind: "connector"; key: string; app: string }
  | { kind: "askDog" | "delegateDog"; key: string; dogId: string }
  | { kind: "vault"; key: string; site: string }
  | { kind: "other"; key: string }
  | { kind: "command"; id: string; command: string; cwd: string };

const APP_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs",
  googlesheets: "Google Sheets", github: "GitHub", linkedin: "LinkedIn", youtube: "YouTube", hubspot: "HubSpot",
  twitter: "X", x: "X",
};

export function appName(slug: string): string {
  return APP_NAMES[slug] ?? slug.split(/[_-]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

export function grantItem(key: string): AllowedItem {
  if (key.startsWith("connector:")) return { kind: "connector", key, app: appName(key.slice("connector:".length)) };
  const site = vaultAllowSite(key);
  if (site) return { kind: "vault", key, site };
  const peer = /^(ask_bot|delegate_bot):(.+)$/.exec(key);
  if (peer) return { kind: peer[1] === "ask_bot" ? "askDog" : "delegateDog", key, dogId: peer[2]! };
  return { kind: "other", key };
}

export function allowedItems(alwaysAllow: readonly string[] | undefined, rules: readonly CommandAllowlistRule[]): AllowedItem[] {
  return [
    ...(alwaysAllow ?? []).map(grantItem),
    ...rules.map((rule): AllowedItem => ({ kind: "command", id: rule.id, command: rule.command, cwd: rule.cwd })),
  ];
}

export function withoutGrant(alwaysAllow: readonly string[] | undefined, key: string): string[] {
  return (alwaysAllow ?? []).filter((candidate) => candidate !== key);
}
