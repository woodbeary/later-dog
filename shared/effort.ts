import { EFFORT_LEVELS, type EffortLevel } from "./wire.ts";

export const STANDARD_EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_LEVELS.filter((level) => level !== "ultra");

export interface EffortModel {
  effortLevels?: readonly EffortLevel[];
  defaultEffort?: EffortLevel;
}

export function modelEffortLevels(offered: readonly EffortLevel[], model?: EffortModel): EffortLevel[] {
  const own = model?.effortLevels;
  return own ? offered.filter((level) => own.includes(level)) : offered.filter((level) => level !== "ultra");
}

export function fitEffort(levels: readonly EffortLevel[], effort: EffortLevel | undefined): EffortLevel | undefined {
  if (!effort || levels.includes(effort)) return effort;
  const lower = EFFORT_LEVELS.slice(1, EFFORT_LEVELS.indexOf(effort)).filter((level) => levels.includes(level));
  return lower.at(-1);
}

export function modelEffort(values: unknown, key: string, fallback: unknown): EffortModel {
  if (!Array.isArray(values)) return {};
  const named = new Set(values.map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined)));
  const effortLevels = EFFORT_LEVELS.filter((level) => named.has(level));
  const defaultEffort = effortLevels.find((level) => level === fallback);
  return { effortLevels, ...(defaultEffort ? { defaultEffort } : {}) };
}
