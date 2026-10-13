import { fitEffort, modelEffortLevels } from "../../shared/effort.ts";
import type { EffortLevel, ModelCatalog } from "../contracts.ts";
import { versionAtLeast, type VersionTriple } from "../drivers/acp/core.ts";

export const CLAUDE_ULTRACODE_FLOOR: VersionTriple = [2, 1, 293];

const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_WITH_ULTRACODE: readonly EffortLevel[] = [...CLAUDE_EFFORT_LEVELS, "ultra"];

export function claudeEffortLevels(version: VersionTriple | null): readonly EffortLevel[] {
  return version && versionAtLeast(version, CLAUDE_ULTRACODE_FLOOR) ? CLAUDE_WITH_ULTRACODE : CLAUDE_EFFORT_LEVELS;
}

export function claudeEffortArg(effort: EffortLevel): string {
  return effort === "ultra" ? "ultracode" : effort;
}

interface EffortInstance {
  readonly models: ModelCatalog;
  readonly adapter: { readonly capabilities: { readonly effortLevels?: readonly EffortLevel[] } };
}

export function offeredEffortLevels(instance: EffortInstance | null | undefined, model: string): EffortLevel[] {
  if (!instance) return [];
  return modelEffortLevels(instance.adapter.capabilities.effortLevels ?? [], instance.models.options.find((option) => option.id === model));
}

export function fittedEffort(instance: EffortInstance, model: string, effort: EffortLevel | undefined): EffortLevel | undefined {
  return fitEffort(offeredEffortLevels(instance, model), effort);
}

export function engineRefusesEffort(instance: EffortInstance, effort: EffortLevel | undefined): boolean {
  return effort !== undefined && effort !== "ultra" && !instance.adapter.capabilities.effortLevels?.includes(effort);
}
