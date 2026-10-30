interface QuestionMessage {
  id: string;
  card?: {
    requestId?: string;
    requestType?: string;
    answered?: string;
    dismissed?: boolean;
    questionRequest?: { questions?: readonly { question: string }[] } | null;
  } | null;
}

export function openQuestion<M extends QuestionMessage>(messages: readonly M[], waiting: (requestId: string) => boolean): M | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const card = messages[index]!.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (!card.questionRequest && card.requestType !== "question") continue;
    if (waiting(card.requestId)) return messages[index];
  }
  return undefined;
}

export function typedReplyAnswer(reply: string, questions: readonly { question: string }[] = []): string {
  const answer = [
    "The person replied in the chat instead of picking an option:",
    reply,
    "Take that as their answer, or as a new request if it is about something else, and reply to it now.",
  ].join("\n\n");
  return questions.length > 1 ? `Q: ${questions[0]!.question}\nA: ${answer}` : answer;
}
