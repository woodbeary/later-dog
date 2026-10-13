import type { EffortLevel } from "../../shared/wire";
import { modelEffortLevels } from "../../shared/effort";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { InstanceInfo } from "@/state/store";

const EFFORT_NAMES: Record<EffortLevel, LocaleKey> = {
  none: "model.effort.off",
  low: "model.effort.low",
  medium: "model.effort.medium",
  high: "model.effort.high",
  xhigh: "model.effort.extraHigh",
  max: "model.effort.max",
  ultra: "model.effort.ultra",
};

const CLAUDE_EFFORT_NAMES: Partial<Record<EffortLevel, LocaleKey>> = {
  xhigh: "model.effort.xHigh",
  ultra: "model.effort.ultracode",
};

export function effortName(level: EffortLevel, driverKind?: string): string {
  return t((driverKind === "claudeAgent" ? CLAUDE_EFFORT_NAMES[level] : undefined) ?? EFFORT_NAMES[level]);
}

export function effortNote(level: EffortLevel): string | undefined {
  return level === "ultra" ? t("model.effort.ultraNote") : undefined;
}

export function effortLevelsFor(instance: InstanceInfo | undefined, model: string): EffortLevel[] {
  return modelEffortLevels(instance?.capabilities?.effortLevels ?? [], instance?.models?.options.find((option) => option.id === model));
}

export function recommendedEffort(levels: readonly EffortLevel[], preferred?: EffortLevel): EffortLevel | undefined {
  if (preferred && levels.includes(preferred)) return preferred;
  return levels.includes("medium") ? "medium" : undefined;
}

export function simpleEffortLevels(levels: readonly EffortLevel[], current: EffortLevel | undefined): EffortLevel[] {
  const top: EffortLevel = levels.includes("max") ? "max" : "xhigh";
  const preferred: EffortLevel[] = ["low", "medium", "high", top, "ultra"];
  let shown = preferred.filter((level) => levels.includes(level));
  if (shown.length === 0) shown = levels.slice(0, 4);
  if (current && levels.includes(current) && !shown.includes(current)) {
    shown = [...shown, current].sort((a, b) => levels.indexOf(a) - levels.indexOf(b));
  }
  return shown;
}

const BLURBS: readonly [RegExp, LocaleKey][] = [
  [/opus/, "model.blurb.smartest"],
  [/sonnet/, "model.blurb.balanced"],
  [/haiku/, "model.blurb.fastest"],
  [/\b(mini|nano|flash|lite)\b|-(mini|nano|flash|lite)\b/, "model.blurb.light"],
];

export function modelBlurb(option: { id: string; label: string }): string | undefined {
  const name = `${option.id} ${option.label}`.toLowerCase();
  const match = BLURBS.find(([pattern]) => pattern.test(name));
  return match ? t(match[1]) : undefined;
}
