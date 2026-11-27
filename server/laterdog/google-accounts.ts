import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";

const noControl = (value: string) => !/\p{Cc}/u.test(value);
export const createGeminiKeyAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(80).refine(noControl),
  apiKey: z.string().trim().min(20).max(200).refine((value) => /^[\x21-\x7e]+$/.test(value)),
  use: z.enum(["free", "paid"]),
}).strict();

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

export function newGeminiKeyAccount(current: InstanceConfigMap, displayName: string, apiKey: string, newId: () => string = randomUUID): { instanceId: string; instances: InstanceConfigMap } {
  const instances = { ...current };
  const cli = cliOf(Object.values(instances).find((entry) => entry.driver === "geminiAgent"));
  const instanceId = `gemini-${newId()}`;
  instances[instanceId] = { driver: "geminiAgent", displayName, environment: { GEMINI_API_KEY: apiKey }, ...(cli ? { config: { cli } } : {}) };
  return { instanceId, instances };
}
