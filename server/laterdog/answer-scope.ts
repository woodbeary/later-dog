import type { Message, Store } from "../store.ts";

export type AnswerScope = "once" | "always" | "chat";

type ScopeBody = { always?: unknown; rememberCommand?: unknown; scope?: unknown };

export interface GrantLookup {
  hasKey(threadId: string, key: string, askerBotId?: string): boolean;
}

type ScopeStore = Pick<Store, "messagesFor" | "patchMessage">;
type Card = NonNullable<Message["card"]>;

export function answerScopeOf(behavior: string, body: ScopeBody): AnswerScope | undefined {
  if (behavior !== "allow") return undefined;
  if (body.rememberCommand === true || body.scope === "always") return "always";
  if (body.always === true || body.scope === "chat") return "chat";
  return "once";
}

function isProposal(card: Card): boolean {
  return Boolean(card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest ||
    card.teamMemoryRequest || card.questionRequest || card.takeoverRequest);
}

function confirmedScope(claimed: AnswerScope, message: Message, body: ScopeBody, threadId: string, grants: GrantLookup): AnswerScope {
  const card = message.card!;
  if (claimed === "chat") return card.allowSession === true ? "chat" : "once";
  if (claimed !== "always" || body.rememberCommand === true) return "once";
  return card.allowKey && grants.hasKey(threadId, card.allowKey, message.from?.botId) ? "always" : "once";
}

export function recordAnswerScope(
  store: ScopeStore,
  threadId: string,
  requestId: string,
  behavior: string,
  body: ScopeBody,
  grants: GrantLookup,
): void {
  const claimed = answerScopeOf(behavior, body);
  if (!claimed) return;
  const message: Message | undefined = store.messagesFor(threadId).find((candidate) =>
    candidate.card?.requestId === requestId && candidate.card.tool && !candidate.card.answered);
  if (!message?.card || isProposal(message.card)) return;
  store.patchMessage(threadId, message.id, {
    card: { ...message.card, answerScope: confirmedScope(claimed, message, body, threadId, grants) },
  });
}

export function confirmRememberedCommand(store: ScopeStore, threadId: string, requestId: string): void {
  const message = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
  if (!message?.card || isProposal(message.card) || message.card.answerScope !== "once") return;
  store.patchMessage(threadId, message.id, { card: { ...message.card, answerScope: "always" } });
}
