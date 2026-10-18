import type { InstanceInfo } from "@/state/store";
import { isShownEngine } from "../../shared/account-engines";

export function pickableInstance(instance: InstanceInfo): boolean {
  if (instance.snapshot.state !== "available") return false;
  if (instance.access === "api") return instance.snapshot.authenticated === true;
  return isShownEngine(instance.driverKind) && instance.snapshot.authenticated !== false;
}

export function signedInModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (pickableInstance(instance) && (instance.models.options.length > 0 || instance.snapshot.chatgptPlan === true)));
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

export type SignInFamily = "claude" | "openai";

export function signInFamily(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): SignInFamily | undefined {
  if (!instance || instance.access === "api") return undefined;
  if (instance.driverKind === "claudeAgent") return "claude";
  if (instance.driverKind === "codex") return "openai";
  return undefined;
}

export const SIGN_IN_FAMILY_LABEL: Record<SignInFamily, string> = { claude: "Claude", openai: "OpenAI" };

export function isClaudeAccount(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): boolean {
  return signInFamily(instance) === "claude";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  api: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const api: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    const access = (instance as { access?: InstanceInfo["access"] }).access;
    if (access === "custom") custom.push(instance);
    else if (access === "api") api.push(instance);
    else subscription.push(instance);
  }
  return { subscription, api, custom };
}
