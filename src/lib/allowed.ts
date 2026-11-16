import type { CommandAllowlistRule } from "../../shared/command-allowlist";
import { vaultAllowSite } from "../../shared/vault";

export type AllowedItem =
  | { kind: "connector"; key: string; app: string }
  | { kind: "askDog" | "delegateDog"; key: string; dogId: string }
  | { kind: "vault"; key: string; site: string }
  | { kind: "other"; key: string }
  | { kind: "command"; id: string; command: string; cwd: string };

import { appName } from "./app-name";

export { appName };

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
