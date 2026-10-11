import { isPersistentQuestionCard, QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question.ts";

type QuestionCard = NonNullable<Parameters<typeof isPersistentQuestionCard>[0]> & { answered?: string; dismissed?: boolean };

export function asksToCloseQuestion(card: QuestionCard, body: { dismiss?: unknown; message?: unknown } | null | undefined): boolean {
  return isPersistentQuestionCard(card) && (body?.dismiss === true || body?.message === QUESTION_DISMISS_MESSAGE);
}

export interface CloseQuestionDeps<Card> {
  answer(message: string): Promise<string>;
  current(): Card | undefined;
  save(card: Card): void;
}

export async function closeQuestion<Card extends QuestionCard>(
  card: Card,
  deps: CloseQuestionDeps<Card>,
): Promise<{ status: 200; body: { ok: true; dismissed: true; outcome?: string } }> {
  if (card.dismissed) return { status: 200, body: { ok: true, dismissed: true } };
  const outcome = card.answered ? undefined : await deps.answer(QUESTION_DISMISS_MESSAGE);
  const latest = deps.current() ?? card;
  if (!latest.dismissed) deps.save({ ...latest, answered: latest.answered ?? "answer", dismissed: true });
  return { status: 200, body: { ok: true, dismissed: true, ...(outcome ? { outcome } : {}) } };
}
