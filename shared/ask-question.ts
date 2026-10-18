export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
export const QUESTION_DISMISS_MESSAGE =
  "later.dog: they closed this question without answering, so do not ask it again. If you can go on without the answer, use your best judgment; if not, stop. Either way, reply in one short line written to them as \"you\".";
export const LEGACY_QUESTION_DISMISS_MESSAGE = "The user closed this question without answering. Use your best judgment and continue.";

export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 12;
export const MAX_QUESTION_TEXT = 8_000;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 400;
export const MAX_CUSTOM_ANSWER = 2000;

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface QuestionRequestCardData {
  version: 1;
  questions: AskQuestion[];
  origin?: "tool" | "output";
}

export function isPersistentQuestionCard(card?: {
  requestType?: "permission" | "question";
  questionRequest?: unknown;
  tool?: string;
  routineRequest?: unknown;
  skillRequest?: unknown;
  profileRequest?: unknown;
  modelRequest?: unknown;
} | null): boolean {
  return Boolean(card && (
    card.requestType === "question" || card.questionRequest ||
    (!card.requestType && !card.tool && !card.routineRequest && !card.skillRequest && !card.profileRequest &&
      !card.modelRequest)
  ));
}

export function shouldSettleRequestCard(card: Parameters<typeof isPersistentQuestionCard>[0], source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer"): boolean {
  return !isPersistentQuestionCard(card) || source === "user";
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit).trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): AskQuestionOption | null {
  if (typeof value === "string") {
    const label = text(value, MAX_LABEL);
    return label ? { label } : null;
  }
  if (!isRecord(value)) return null;
  const label = text(value.label, MAX_LABEL);
  if (!label) return null;
  const description = text(value.description, MAX_DESCRIPTION);
  return description ? { label, description } : { label };
}

function parseQuestion(value: unknown): AskQuestion | null {
  if (!isRecord(value)) return null;
  const question = text(value.question, MAX_QUESTION_TEXT);
  if (!question) return null;
  const options: AskQuestionOption[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.options) ? value.options : []) {
    const option = parseOption(raw);
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  const header = text(value.header, MAX_LABEL);
  return {
    question,
    ...(header ? { header } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    options,
  };
}

export function parseAskQuestions(input: unknown): AskQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions: AskQuestion[] = [];
  for (const raw of input.questions) {
    const question = parseQuestion(raw);
    if (!question) continue;
    questions.push(question);
    if (questions.length === MAX_QUESTIONS) break;
  }
  return questions.length ? questions : null;
}

export function askQuestionSummary(questions: readonly AskQuestion[]): string {
  const first = questions[0]?.question ?? "";
  const rest = questions.length - 1;
  return rest > 0 ? `${first} (+${rest} more question${rest > 1 ? "s" : ""})` : first;
}

export const MAX_CHOICES = 5;

export function parseChoices(input: unknown, limit = MAX_CHOICES): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const label = typeof raw === "string" ? text(raw, MAX_LABEL) : isRecord(raw) ? text(raw.label, MAX_LABEL) : undefined;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    choices.push(label);
    if (choices.length === limit) break;
  }
  return choices.length ? choices : undefined;
}

export function questionChoices(questions: readonly AskQuestion[]): string[] | undefined {
  if (questions.length !== 1) return undefined;
  const only = questions[0]!;
  if (only.multiSelect || only.options.length < 2) return undefined;
  return only.options.map((option) => option.label);
}

export const ASK_USER_TOOL = "ask_user";

export const ASK_USER_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: ASK_USER_TOOL,
    description:
      "Ask the person questions when the decision is theirs. Offer concrete options where they exist; they can always answer in their own words. Ask up to six questions in one call rather than one at a time.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question to show the person." },
              header: { type: "string", description: "A short label for the question's tab." },
              multiSelect: { type: "boolean", description: "Whether several options may be picked." },
              options: {
                type: "array",
                maxItems: MAX_OPTIONS,
                description: "Suggested answers; the person may always write their own.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
} as const;

export const ANSWER_PREAMBLE = "The person answered your questions.";
export const LEGACY_ANSWER_PREAMBLE = "The user answered your questions.";

export function formatQuestionAnswers(
  questions: readonly AskQuestion[],
  answers: readonly (readonly string[])[],
): string {
  const blocks: string[] = [];
  questions.forEach((question, index) => {
    const picked = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean);
    if (!picked.length) return;
    blocks.push(`Q: ${question.question}\nA: ${picked.join(", ")}`);
  });
  if (!blocks.length) return "";
  return `${ANSWER_PREAMBLE}\n\n${blocks.join("\n\n")}`;
}

export function answerWithoutPreamble(answer: string): string {
  const preamble = [ANSWER_PREAMBLE, LEGACY_ANSWER_PREAMBLE].find((candidate) => answer.startsWith(`${candidate}\n\n`));
  return preamble ? answer.slice(preamble.length + 2) : answer;
}

export function questionAnswersByQuestion(
  message: string,
  questions: readonly AskQuestion[],
): Record<string, string> {
  return questionAnswersById(message, questions.map(question => ({ id: question.question, question })));
}

const MAX_QUESTION_ID = 200;

export interface ProtocolAskQuestion {
  id: string;
  question: AskQuestion;
}

export function parseProtocolAskQuestions(entries: unknown): ProtocolAskQuestion[] | null {
  if (!Array.isArray(entries)) return null;
  const parsed: ProtocolAskQuestion[] = [];
  const seenIds = new Set<string>();
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const question = parseQuestion(raw);
    const id = raw.id;
    if (!question || typeof id !== "string" || !id.trim() || id.length > MAX_QUESTION_ID) continue;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    parsed.push({ id, question });
    if (parsed.length === MAX_QUESTIONS) break;
  }
  return parsed.length ? parsed : null;
}

export function questionAnswersById(
  message: string,
  questions: readonly ProtocolAskQuestion[],
): Record<string, string> {
  const answers: Record<string, string> = Object.create(null);
  if (message === QUESTION_DISMISS_MESSAGE) {
    for (const { id } of questions) answers[id] = message;
    return answers;
  }
  const idByText = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { id, question } of questions) {
    if (idByText.has(question.question)) {
      ambiguous.add(question.question);
      continue;
    }
    idByText.set(question.question, id);
  }
  const blocks = message.matchAll(/(?:^|\n\n)Q: ([\s\S]+?)\nA: ([\s\S]*?)(?=\n\nQ: |$)/g);
  let sawBlock = false;
  for (const match of blocks) {
    sawBlock = true;
    const asked = match[1]!.trim();
    if (ambiguous.has(asked)) continue;
    const id = idByText.get(asked);
    const answer = match[2]!.trim();
    if (id && answer) answers[id] = answer;
  }
  if (Object.keys(answers).length) return answers;
  if (sawBlock) return {};
  const only = questions.length === 1 ? questions[0] : undefined;
  const flat = message.trim();
  return only && flat ? { [only.id]: flat } : {};
}
