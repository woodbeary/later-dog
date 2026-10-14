import type { Message, Store } from "../store.ts";

export type AnswerScope = "once" | "always" | "chat";

type ScopeBody = { always?: unknown; rememberCommand?: unknown; scope?: unknown };

export function answerScopeOf(behavior: string, body: ScopeBody): AnswerScope | undefined {
  if (behavior !== "allow") return undefined;
  if (body.rememberCommand === true || body.scope === "always") return "always";
  if (body.always === true || body.scope === "chat") return "chat";
  return "once";
}

export function recordAnswerScope(
  store: Pick<Store, "messagesFor" | "patchMessage">,
  threadId: string,
  requestId: string,
  behavior: string,
  body: ScopeBody,
): void {
  const scope = answerScopeOf(behavior, body);
  if (!scope) return;
  const message: Message | undefined = store.messagesFor(threadId).find((candidate) =>
    candidate.card?.requestId === requestId && candidate.card.tool && !candidate.card.answered);
  if (!message?.card) return;
  store.patchMessage(threadId, message.id, { card: { ...message.card, answerScope: scope } });
}
