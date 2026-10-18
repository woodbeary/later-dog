import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import { SHOWN_ENGINES } from "../../shared/account-engines.ts";
import { engineMoveText, type EngineMoveFacts } from "../computer-engine-removal.ts";

export const API_KEY_DRIVERS = ["grok", "openai-compat"] as const;

export const OFFERED_DRIVERS: ReadonlySet<string> = new Set<string>([...SHOWN_ENGINES, ...API_KEY_DRIVERS]);

export const RETIRED_DRIVERS: ReadonlySet<string> = new Set([
  "kimiAgent", "droidAgent", "geminiAgent", "antigravityAgent", "opencodeGo", "qwenAgent",
  "hermesAgent", "customAcp", "piAgent", "mistral", "cerebras", "minimax",
]);

const RETIRED_BUILT_IN_INSTANCES: Readonly<Record<string, string>> = {
  kimi: "kimiAgent",
  droid: "droidAgent",
  antigravity: "antigravityAgent",
  opencodeGo: "opencodeGo",
  openaiCompat: "openai-compat",
  openrouter: "openai-compat",
  mistral: "mistral",
  cerebras: "cerebras",
  qwen: "qwenAgent",
  hermes: "hermesAgent",
  pi: "piAgent",
};

export function retiredInstanceIds(saved: InstanceConfigMap | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, builtInDriver] of Object.entries(RETIRED_BUILT_IN_INSTANCES)) {
    const entry = saved && Object.hasOwn(saved, id) ? saved[id] : undefined;
    if (!entry || entry.driver === builtInDriver || RETIRED_DRIVERS.has(entry.driver)) ids.add(id);
  }
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (RETIRED_DRIVERS.has(entry.driver)) ids.add(id);
  }
  return ids;
}

export function withoutRetiredEngines(map: InstanceConfigMap, saved: InstanceConfigMap | undefined): InstanceConfigMap {
  const retired = retiredInstanceIds(saved);
  for (const [id, entry] of Object.entries(map)) {
    if (retired.has(id) || RETIRED_DRIVERS.has(entry.driver)) delete map[id];
  }
  return map;
}

export function namesRetiredInstance(retired: ReadonlySet<string>, selection: Pick<ModelSelection, "instanceId"> | undefined): boolean {
  return Boolean(selection && retired.has(selection.instanceId));
}

export function retiredEngineMoveText(move: EngineMoveFacts, botName: string, engine: string): string {
  return engineMoveText(move, botName, engine, "The model it used before is no longer offered.");
}
