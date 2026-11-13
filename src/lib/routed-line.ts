import { t } from "@/lib/i18n";

export interface RoutedAccount {
  instanceId: string;
  driverKind: string;
  displayName: string;
}

const ENGINE_NAME: Record<string, string> = { claudeAgent: "Claude", codex: "ChatGPT" };

export function crossEngine(chosen: RoutedAccount | undefined, running: RoutedAccount | undefined): boolean {
  return Boolean(chosen && running && chosen.instanceId !== running.instanceId && chosen.driverKind !== running.driverKind);
}

export function withEngine(account: RoutedAccount): string {
  const name = account.displayName.trim();
  const engine = ENGINE_NAME[account.driverKind];
  return engine && !name.toLowerCase().includes(engine.toLowerCase()) ? `${name} (${engine})` : name;
}

export function routedLine(chosen: RoutedAccount | undefined, running: RoutedAccount | undefined, nextMessage: boolean): string | null {
  if (!chosen || !running || chosen.instanceId === running.instanceId) return null;
  if (nextMessage) return t("accounts.fromNextMessage");
  const named = crossEngine(chosen, running) ? withEngine : (account: RoutedAccount) => account.displayName.trim();
  return t("accounts.runningUntilBack", { name: named(running), from: named(chosen) });
}
