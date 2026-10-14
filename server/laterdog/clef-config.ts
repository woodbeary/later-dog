import type { AppConfig } from "../config.ts";
import { deciderJobOn, deciderModel, deciderReady } from "../decider/index.ts";

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

export function describeClef(cfg: AppConfig) {
  const model = deciderModel(cfg);
  return {
    ready: deciderReady(cfg, "autoReview"),
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
