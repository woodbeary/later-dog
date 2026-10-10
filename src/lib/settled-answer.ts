import { answerWithoutPreamble, type AskQuestion } from "../../shared/ask-question";

export function settledAnswer(answer: string, questions: readonly Pick<AskQuestion, "question">[]): string {
  const text = answerWithoutPreamble(answer);
  if (questions.length !== 1) return text;
  const prefix = `Q: ${questions[0]!.question}\nA: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
