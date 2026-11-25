import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type AskQuestion,
  type AskQuestionOption,
  type QuestionRequestCardData,
} from "./ask-question.ts";

export const QUESTION_AUTOPICK_MS = 3 * 60_000;

const RECOMMENDED = /\(recommended\)\s*$/i;
const MAX_PICK = 120;

export function recommendedOption(
  options: readonly AskQuestionOption[],
): AskQuestionOption | undefined {
  return options.find((option) => RECOMMENDED.test(option.label));
}

function waitedWords(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} min`
    : `${Math.max(1, Math.round(ms / 1000))} s`;
}

export interface AutoPickedAnswer {
  engine: string;
  card: string;
}

export function autoPickedAnswer(
  card: {
    questionRequest?: Pick<QuestionRequestCardData, "questions">;
    options?: readonly string[];
  },
  kept: readonly (readonly string[])[],
  context: { waitedMs: number; owner?: string; delegated?: boolean },
): AutoPickedAnswer {
  const onTheirOwn = context.delegated
    ? "Full access delegates this decision to you. Use your best judgment and keep going. The person can correct you later."
    : `${context.owner?.trim() || "The person"} didn't answer in time. Use your best judgment and keep going. They can correct you later.`;
  const questions: readonly AskQuestion[] = card.questionRequest?.questions.length
    ? card.questionRequest.questions
    : [{ question: "", options: (card.options ?? []).map((label) => ({ label })) }];
  const answers = questions.map((question, index): AutoPickedAnswer => {
    const offered = new Set(question.options.map((option) => option.label));
    const mine = (kept[index] ?? []).filter((label) => offered.has(label));
    if (mine.length) return { engine: mine.join(", "), card: mine.join(", ") };
    const recommended = recommendedOption(question.options);
    const pick = recommended ?? question.options[0];
    if (!pick) return { engine: onTheirOwn, card: "No answer" };
    return {
      engine: context.delegated
        ? pick.label
        : `No answer after ${waitedWords(context.waitedMs)}; auto-picked the ${recommended ? "recommended" : "first"} option: ${pick.label}`,
      card: pick.label,
    };
  });
  if (!card.questionRequest?.questions.length) return answers[0]!;
  const blocks = (side: keyof AutoPickedAnswer) =>
    questions
      .map((question, index) => `Q: ${question.question}\nA: ${answers[index]![side]}`)
      .join("\n\n");
  return { engine: blocks("engine"), card: blocks("card") };
}

export function questionPicks(input: unknown): string[][] | null {
  if (!Array.isArray(input) || input.length > MAX_QUESTIONS) return null;
  const picks: string[][] = [];
  for (const entry of input) {
    if (!Array.isArray(entry)) return null;
    picks.push(
      entry
        .slice(0, MAX_OPTIONS)
        .flatMap((label) =>
          typeof label === "string" && label.trim() ? [label.trim().slice(0, MAX_PICK)] : [],
        ),
    );
  }
  return picks;
}
