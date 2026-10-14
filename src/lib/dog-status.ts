import type { Message } from "@/state/store";

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

export function sendInFlight(messages: readonly Pick<Message, "id" | "role">[]): boolean {
  const last = messages.at(-1);
  return last !== undefined && last.role === "user" && last.id.startsWith(OPTIMISTIC_PREFIX);
}
