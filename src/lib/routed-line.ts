import { t } from "@/lib/i18n";

export interface RoutedAccount {
  instanceId: string;
  driverKind: string;
  displayName: string;
  enabled?: boolean;
  snapshot?: { authenticated?: boolean };
}

export type RoutedWhy = "off" | "usedUp" | "signedOut";

const ENGINE_NAME: Record<string, string> = { claudeAgent: "Claude", codex: "ChatGPT" };

export function crossEngine(chosen: RoutedAccount | undefined, running: RoutedAccount | undefined): boolean {
  return Boolean(chosen && running && chosen.instanceId !== running.instanceId && chosen.driverKind !== running.driverKind);
}

export function withEngine(account: RoutedAccount): string {
  const name = account.displayName.trim();
  const engine = ENGINE_NAME[account.driverKind];
  return engine && !name.toLowerCase().includes(engine.toLowerCase()) ? `${name} (${engine})` : name;
}

export function routedWhy(chosen: RoutedAccount, resting: boolean): RoutedWhy | null {
  if (resting) return "usedUp";
  if (chosen.enabled === false) return "off";
  if (chosen.snapshot?.authenticated === false) return "signedOut";
  return null;
}

export function routedLine(chosen: RoutedAccount | undefined, running: RoutedAccount | undefined, resting: boolean): string | null {
  if (!chosen || !running || chosen.instanceId === running.instanceId) return null;
  const named = crossEngine(chosen, running) ? withEngine : (account: RoutedAccount) => account.displayName.trim();
  const from = named(chosen);
  const name = named(running);
  const why = routedWhy(chosen, resting);
  if (why === "off") return t("accounts.routedOff", { from, name });
  if (why === "usedUp") return t("accounts.routedUsedUp", { from, name });
  if (why === "signedOut") return t("accounts.routedSignedOut", { from, name });
  return t("accounts.runningOn", { name });
}
