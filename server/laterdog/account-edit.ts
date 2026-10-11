import type { InstanceConfig } from "../contracts.ts";

export type AccountEditVerdict = { ok: true } | { ok: false; error: string };

export const DEFAULT_ACCOUNT_IDS: readonly string[] = ["claude", "chatgpt", "codex"];

export function chatgptPlanAccount(entry: Pick<InstanceConfig, "driver" | "config">): boolean {
  const config = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {};
  return entry.driver === "codex" && config.authMode === "chatgpt-plan";
}

export function subscriptionAccount(entry: Pick<InstanceConfig, "driver" | "config">): boolean {
  return entry.driver === "claudeAgent" || entry.driver === "codex";
}

export function renamableAccount(entry: Pick<InstanceConfig, "driver" | "config">): AccountEditVerdict {
  if (entry.driver === "claudeAgent" || chatgptPlanAccount(entry)) return { ok: true };
  if (entry.driver === "codex") return { ok: false, error: "This Codex login keeps its name; add a ChatGPT account to name one." };
  return { ok: false, error: "Only Claude and ChatGPT accounts can be renamed here." };
}

export function removableAccount(instanceId: string, entry: Pick<InstanceConfig, "driver" | "config">): AccountEditVerdict {
  if (DEFAULT_ACCOUNT_IDS.includes(instanceId)) return { ok: false, error: "The default account stays. Sign out of it instead." };
  if (entry.driver === "claudeAgent" || chatgptPlanAccount(entry)) return { ok: true };
  return { ok: false, error: "Only added Claude and ChatGPT accounts can be removed here." };
}
