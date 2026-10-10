import type { Message } from "@/state/store";

export function openQuestion(messages: readonly Message[]): { id: string; message: Message } | undefined {
  const message = messages.find(({ kind, card }) =>
    kind === "options" &&
    card?.requestType === "question" &&
    Boolean(card.requestId) &&
    !card.answered &&
    !card.dismissed &&
    !card.expired);
  return message?.card?.requestId ? { id: message.card.requestId, message } : undefined;
}
