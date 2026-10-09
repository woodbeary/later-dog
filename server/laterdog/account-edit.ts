// Settings → Accounts: which provider instances a person may rename or
// remove there. An account is a Claude login (the default `claude` or an
// added `claude-<uuid>`) or a ChatGPT plan login (the default `chatgpt` or
// an added `chatgpt-<uuid>`). The defaults stay: a dog's model picker and
// the engine list rely on them. Removing an entry only forgets later.dog's
// configuration; credentials on disk are never touched here.
import type { InstanceConfig } from "../contracts.ts";

export type AccountEditVerdict = { ok: true } | { ok: false; error: string };

export const DEFAULT_ACCOUNT_IDS: readonly string[] = ["claude", "chatgpt", "codex"];

/** A ChatGPT plan login: Codex driven by the plan's own sign-in. */
export function chatgptPlanAccount(entry: Pick<InstanceConfig, "driver" | "config">): boolean {
  const config = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {};
  return entry.driver === "codex" && config.authMode === "chatgpt-plan";
}

/** Whether Settings → Accounts lists this instance as an account at all. */
export function subscriptionAccount(entry: Pick<InstanceConfig, "driver" | "config">): boolean {
  return entry.driver === "claudeAgent" || entry.driver === "codex";
}

/** Whether the account's name may change from Settings → Accounts. */
export function renamableAccount(instanceId: string, entry: Pick<InstanceConfig, "driver" | "config">): AccountEditVerdict {
  if (entry.driver === "claudeAgent" || chatgptPlanAccount(entry)) return { ok: true };
  if (entry.driver === "codex") return { ok: false, error: "This Codex login keeps its name; add a ChatGPT account to name one." };
  return { ok: false, error: "Only Claude and ChatGPT accounts can be renamed here." };
}

/** Whether the account may be removed from Settings → Accounts: an added
 * Claude or ChatGPT account, never a default the app relies on. */
export function removableAccount(instanceId: string, entry: Pick<InstanceConfig, "driver" | "config">): AccountEditVerdict {
  if (DEFAULT_ACCOUNT_IDS.includes(instanceId)) return { ok: false, error: "The default account stays. Sign out of it instead." };
  if (entry.driver === "claudeAgent" || chatgptPlanAccount(entry)) return { ok: true };
  return { ok: false, error: "Only added Claude and ChatGPT accounts can be removed here." };
}
