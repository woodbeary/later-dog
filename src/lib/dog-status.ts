export type AttentionKind = "waiting" | "unread";

export function attentionKind(facts: { waiting: boolean; unread?: boolean }): AttentionKind | null {
  if (facts.waiting) return "waiting";
  if (facts.unread) return "unread";
  return null;
}

export const OPTIMISTIC_PREFIX = "optimistic-";
