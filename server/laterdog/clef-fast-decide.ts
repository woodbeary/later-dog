import type { Decider } from "../decider/index.ts";
import type { Answers, AskOptions, ChoiceAnswer, DeciderFailure, DeciderQuestion, DeciderSeam, YesNoAnswer } from "../decider/types.ts";
import { prepareClefImages, type ImageRefusal, type ImageShrinker, type ImageSource } from "./clef-images.ts";

export const FAST_DECIDE_BUDGET_MS = 1_500;

export type FastFallback = DeciderFailure | ImageRefusal | "no_decider";

export type FastDecision<A> =
  | { decided: true; answers: A; latencyMs: number; model?: string }
  | { decided: false; reason: FastFallback; latencyMs?: number };

export interface FastDecideOptions extends Omit<AskOptions, "images"> {
  budgetMs?: number;
  images?: readonly ImageSource[];
  shrink?: ImageShrinker;
}

export async function fastDecide<Qs extends Record<string, DeciderQuestion>>(
  decider: Pick<Decider, "ask"> | undefined,
  seam: DeciderSeam,
  state: unknown,
  questions: Qs,
  options: FastDecideOptions = {},
): Promise<FastDecision<Answers<Qs>>> {
  if (!decider) return { decided: false, reason: "no_decider" };
  const { budgetMs, images, shrink, ...rest } = options;
  let prepared: string[] | undefined;
  if (images?.length) {
    const result = await prepareClefImages(images, { shrink });
    if (!result.ok) return { decided: false, reason: result.reason };
    prepared = result.images;
  }
  try {
    const answered = await decider.ask(seam, state, questions, {
      ...rest,
      timeoutMs: budgetMs ?? rest.timeoutMs ?? FAST_DECIDE_BUDGET_MS,
      ...(prepared ? { images: prepared } : {}),
    });
    if (!answered.ok) return { decided: false, reason: answered.reason, ...(answered.latencyMs !== undefined ? { latencyMs: answered.latencyMs } : {}) };
    return { decided: true, answers: answered.answers, latencyMs: answered.latencyMs, ...(answered.model ? { model: answered.model } : {}) };
  } catch {
    return { decided: false, reason: "malformed" };
  }
}

export function yes(answer: YesNoAnswer | undefined, atLeast: number): boolean {
  return answer !== undefined && answer.p >= atLeast;
}

export function chosen<K extends string>(answer: ChoiceAnswer<K> | undefined, atLeast: number): K | null {
  return answer !== undefined && answer.pTop >= atLeast ? answer.choice : null;
}
