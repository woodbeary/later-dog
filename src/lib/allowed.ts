import { readGrantKey } from "../../shared/always-allow";
import { t } from "./i18n";
import type { CommandAllowlistRule } from "../../shared/command-allowlist";
import { vaultAllowSite } from "../../shared/vault";

type Lasting = { key: string; onComputer?: boolean; chatOnly?: boolean };

export type AllowedItem =
  | ({ kind: "connector"; app: string; tool?: string } & Lasting)
  | ({ kind: "run"; command: string; covers: string } & Lasting)
  | ({ kind: "exact"; command: string; cwd: string } & Lasting)
  | ({ kind: "files"; access: "edit" | "read" } & Lasting)
  | ({ kind: "tool"; tool: string } & Lasting)
  | ({ kind: "askDog" | "delegateDog"; dogId: string } & Lasting)
  | ({ kind: "vault"; site: string } & Lasting)
  | ({ kind: "other" } & Lasting)
  | { kind: "command"; id: string; command: string; cwd: string; chatOnly?: undefined };

const APP_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs",
  googlesheets: "Google Sheets", github: "GitHub", linkedin: "LinkedIn", youtube: "YouTube", hubspot: "HubSpot",
  twitter: "X", x: "X",
};

export function appName(slug: string): string {
  return APP_NAMES[slug] ?? slug.split(/[_-]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function toolWords(tool: string): string {
  return tool.replace(/^[a-z0-9]+_/, "").replace(/[_/]+/g, " ").trim();
}

export function grantItem(key: string): AllowedItem {
  if (key.startsWith("connector:")) {
    const [slug = "", tool] = key.slice("connector:".length).split(":");
    return tool ? { kind: "connector", key, app: appName(slug), tool: toolWords(tool) } : { kind: "connector", key, app: appName(slug) };
  }
  const grant = readGrantKey(key);
  if (grant) {
    const where = grant.onComputer ? { onComputer: true } : {};
    switch (grant.shape.kind) {
      case "run": return { kind: "run", key, command: grant.shape.command, covers: grant.shape.covers, ...where };
      case "exact": return { kind: "exact", key, command: grant.shape.command, cwd: grant.shape.cwd, ...where };
      case "files": return { kind: "files", key, access: grant.shape.access, ...where };
      case "tool": return { kind: "tool", key, tool: grant.shape.tool, ...where };
    }
  }
  const site = vaultAllowSite(key);
  if (site) return { kind: "vault", key, site };
  const peer = /^(ask_bot|delegate_bot):(.+)$/.exec(key);
  if (peer) return { kind: peer[1] === "ask_bot" ? "askDog" : "delegateDog", key, dogId: peer[2]! };
  return { kind: "other", key };
}

export function lastingWords(item: AllowedItem): { label: string; detail?: string } | null {
  switch (item.kind) {
    case "run": return { label: t("allowed.run", { command: item.command, covers: item.covers }) };
    case "exact": return { label: t("allowed.exact", { command: item.command }), detail: t("allowed.commandIn", { cwd: item.cwd }) };
    case "files": return { label: t(item.access === "edit" ? "allowed.files" : "allowed.filesRead") };
    case "tool": return { label: t("allowed.tool", { tool: item.tool }) };
    default: return null;
  }
}

export function chatOnlyKeys(alwaysAllow: readonly string[] | undefined, tasks: readonly { alwaysAllow?: string[] }[] | undefined): string[] {
  const dog = new Set(alwaysAllow ?? []);
  return [...new Set((tasks ?? []).flatMap((task) => task.alwaysAllow ?? []))].filter((key) => !dog.has(key));
}

export function allowedItems(
  alwaysAllow: readonly string[] | undefined,
  rules: readonly CommandAllowlistRule[],
  chatOnly: readonly string[] = [],
): AllowedItem[] {
  return [
    ...(alwaysAllow ?? []).map(grantItem),
    ...chatOnly.map((key): AllowedItem => ({ ...grantItem(key), chatOnly: true }) as AllowedItem),
    ...rules.map((rule): AllowedItem => ({ kind: "command", id: rule.id, command: rule.command, cwd: rule.cwd })),
  ];
}

export function withoutGrant(alwaysAllow: readonly string[] | undefined, key: string): string[] {
  return (alwaysAllow ?? []).filter((candidate) => candidate !== key);
}
