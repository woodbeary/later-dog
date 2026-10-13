import { answerWithoutPreamble, type AskQuestion } from "../../shared/ask-question";

export function settledAnswer(answer: string, questions: readonly Pick<AskQuestion, "question">[]): string {
  const text = answerWithoutPreamble(answer);
  if (questions.length !== 1) return text;
  const prefix = `Q: ${questions[0]!.question}\nA: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function answerSummary(answer: string, questions: readonly Pick<AskQuestion, "question">[]): string {
  const text = settledAnswer(answer, questions);
  const answers = [...text.matchAll(/(?:^|\n\n)Q: [\s\S]+?\nA: ([\s\S]*?)(?=\n\nQ: |$)/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  return (answers.length ? answers.join(" · ") : text).replace(/\s+/g, " ").trim();
}
