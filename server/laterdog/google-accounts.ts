import { randomUUID } from "node:crypto";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";

const cliOf = (entry: InstanceConfig | undefined): string | undefined => {
  const cli = (entry?.config as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
};

export function newAntigravityAccount(current: InstanceConfigMap, displayName: string, newId: () => string = randomUUID): { instanceId: string; instances: InstanceConfigMap } {
  const instances = { ...current };
  const existing = Object.values(instances).find((entry) => entry.driver === "antigravityAgent");
  const cli = cliOf(existing);
  const instanceId = `antigravity-${newId()}`;
  instances[instanceId] = { driver: "antigravityAgent", displayName, ...(cli ? { config: { cli } } : {}) };
  return { instanceId, instances };
}
