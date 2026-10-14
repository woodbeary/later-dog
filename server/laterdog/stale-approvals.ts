import type { Message } from "../store.ts";

export const RESTART_UNANSWERED_NOTE = "later.dog restarted before this was answered, so the action was not run.";

export interface StaleApprovalDeps {
  cards(): Array<{ threadId: string; message: Message }>;
  owns(threadId: string): boolean;
  patch(threadId: string, messageId: string, patch: Partial<Message>): unknown;
}

export function expireStaleApprovals(deps: StaleApprovalDeps): number {
  let expired = 0;
  for (const { threadId, message } of deps.cards()) {
    const card = message.card;
    if (!card || card.requestType !== "permission" || card.answered || card.dismissed || card.expired) continue;
    if (!deps.owns(threadId)) continue;
    deps.patch(threadId, message.id, {
      card: { ...card, expired: true, options: [], held: RESTART_UNANSWERED_NOTE, heldCode: undefined },
    });
    expired += 1;
  }
  return expired;
}
