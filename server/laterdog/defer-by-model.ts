import { modelFamily, type ModelFamily } from "./dog-guidance.ts";
import { DEFER_RARE_TOOLS_SETTING } from "./tool-loading.ts";

export const DEFER_PROVEN_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>([
  "fable-5-2",
  "fable-5-1",
  "fable-5",
  "opus-5-5",
  "opus-5",
]);

export type DeferSetting = "on" | "off" | "by-model";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function deferSetting(env: Env = process.env): DeferSetting {
  const value = env[DEFER_RARE_TOOLS_SETTING]?.trim().toLowerCase();
  if (value === "1" || value === "on" || value === "true") return "on";
  if (value === "0" || value === "off" || value === "false") return "off";
  return "by-model";
}

const ANTHROPIC_API_HOST = "api.anthropic.com";
const CLOUD_PROVIDER_SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;

const switchedOn = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "0" && normalized !== "false";
};

export function claudeCustomEndpoint(env: Env): boolean {
  if (CLOUD_PROVIDER_SWITCHES.some((key) => switchedOn(env[key]))) return true;
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return false;
  try {
    return new URL(base).hostname.toLowerCase() !== ANTHROPIC_API_HOST;
  } catch {
    return true;
  }
}

export interface DeferTarget {
  model: string | null | undefined;
  customEndpoint: boolean;
}

export interface ClaudeLaunchTarget {
  model: string | null | undefined;
  injected: boolean;
  managed: boolean;
  env: Env;
}

export function claudeRareToolsOnDemand(target: ClaudeLaunchTarget, settings: Env = process.env): boolean {
  return deferRareToolsFor({
    model: target.model || target.env.ANTHROPIC_MODEL,
    customEndpoint: target.managed || target.injected || claudeCustomEndpoint(target.env),
  }, settings);
}

export function deferRareToolsFor(target: DeferTarget, env: Env = process.env): boolean {
  const setting = deferSetting(env);
  if (setting !== "by-model") return setting === "on";
  if (target.customEndpoint || !target.model?.trim()) return false;
  return DEFER_PROVEN_FAMILIES.has(modelFamily(target.model));
}
