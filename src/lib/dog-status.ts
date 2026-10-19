export type DogStatusKind = "waiting" | "working" | "teammates" | "queued";

export interface DogStatusFacts {
  waiting: boolean;
  working: boolean;
  teammates?: boolean;
  queued?: boolean;
}

export function dogStatusKind(facts: DogStatusFacts): DogStatusKind | null {
  if (facts.waiting) return "waiting";
  if (facts.working) return "working";
  if (facts.teammates) return "teammates";
  if (facts.queued) return "queued";
  return null;
}

export const OPTIMISTIC_PREFIX = "optimistic-";
