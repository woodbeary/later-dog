import type { AppConfig } from "../config.ts";
import { deciderCanRun, deciderEndpointLabel, deciderJobOn, deciderModel, deciderModelFor, deciderReady } from "../decider/index.ts";

export const AUTO_REVIEW_MAX_RULES = 20;
export const AUTO_REVIEW_MAX_RULE_CHARS = 1_000;

export interface AutoReviewRules {
  allow: string[];
  block: string[];
}

function cleaned(rules: readonly unknown[] | undefined): string[] {
  return (rules ?? [])
    .filter((rule): rule is string => typeof rule === "string")
    .map((rule) => rule.replace(/\s+/g, " ").trim().slice(0, AUTO_REVIEW_MAX_RULE_CHARS))
    .filter(Boolean)
    .slice(0, AUTO_REVIEW_MAX_RULES);
}

export function autoReviewRules(cfg: AppConfig): AutoReviewRules {
  return { allow: cleaned(cfg.decider?.autoReview?.allow), block: cleaned(cfg.decider?.autoReview?.block) };
}

export type ClefJob = "autoReview" | "turnEnd" | "screenCheck" | "screenshotFilter";
export const CLEF_JOBS: readonly ClefJob[] = ["autoReview", "turnEnd", "screenCheck", "screenshotFilter"];

type DeciderSection = NonNullable<AppConfig["decider"]>;

export function clefWidening(current: DeciderSection | undefined, patch: Partial<DeciderSection>): string[] {
  const widened: string[] = [];
  if (patch.autoReview) {
    const before = autoReviewRules({ decider: current });
    const after = autoReviewRules({ decider: { autoReview: patch.autoReview } });
    if (after.allow.some((rule) => !before.allow.includes(rule))) widened.push("autoReview.allow");
    if (before.block.some((rule) => !after.block.includes(rule))) widened.push("autoReview.block");
  }
  for (const job of CLEF_JOBS) {
    if (patch.jobs?.[job] === true && current?.jobs?.[job] !== true) widened.push(`jobs.${job}`);
  }
  for (const job of CLEF_JOBS) {
    if (patch.jobs?.[job] === false && current?.jobs?.[job] === true) widened.push(`jobs.${job}.off`);
  }
  if (patch.enabled === false && current?.enabled !== false) widened.push("decider.enabled");
  if (patch.provider === "off" && current?.provider !== "off") widened.push("decider.provider");
  if (patch.model !== undefined && patch.model !== current?.model) widened.push("decider.model");
  if (patch.models !== undefined && JSON.stringify(patch.models) !== JSON.stringify(current?.models ?? {})) widened.push("decider.models");
  const sameAddress = (patch.baseUrl ?? current?.baseUrl ?? "").trim() === (current?.baseUrl ?? "").trim();
  const sameKey = (patch.key ?? current?.key ?? "").trim() === (current?.key ?? "").trim();
  if (!sameAddress || !sameKey) widened.push("decider.endpoint");
  return widened;
}

export interface ConfigCaller {
  appOrPairedDevice: boolean;
  dogsWorking: boolean;
}

export const CLEF_WIDENING_REFUSAL =
  "Auto-review rules, the fast-decision switches and where decisions are sent decide what dogs may do without asking. Change them from the app or a paired device.";

export function clefWideningRefusal(
  current: DeciderSection | undefined,
  patch: Partial<DeciderSection> | undefined,
  caller: ConfigCaller,
): string | null {
  if (!patch || caller.appOrPairedDevice || !caller.dogsWorking) return null;
  return clefWidening(current, patch).length ? CLEF_WIDENING_REFUSAL : null;
}

export function describeClef(cfg: AppConfig) {
  const model = deciderModel(cfg);
  return {
    ready: deciderReady(cfg, "autoReview"),
    sendsTo: deciderEndpointLabel(cfg),
    available: Object.fromEntries(CLEF_JOBS.map((job) => [
      job,
      deciderCanRun(cfg, job) && (job === "screenCheck" || job === "screenshotFilter" ? deciderModelFor(cfg, job) !== undefined : true),
    ])) as Record<ClefJob, boolean>,
    ...(model ? { model } : {}),
    autoReview: autoReviewRules(cfg),
    jobs: {
      autoReview: deciderJobOn(cfg, "autoReview"),
      turnEnd: deciderJobOn(cfg, "turnEnd"),
      screenCheck: deciderJobOn(cfg, "screenCheck"),
      screenshotFilter: deciderJobOn(cfg, "screenshotFilter"),
    },
  };
}

export function clefForMembers(clef: ReturnType<typeof describeClef>) {
  return {
    ...clef,
    autoReview: {
      allow: [] as string[],
      block: [] as string[],
      hidden: true as const,
      counts: { allow: clef.autoReview.allow.length, block: clef.autoReview.block.length },
    },
  };
}
