import type { Decider } from "../decider/index.ts";
import type { Answers, AskOptions, ChoiceAnswer, DeciderFailure, DeciderQuestion, DeciderSeam, YesNoAnswer } from "../decider/types.ts";
import type { Breaker } from "./clef-breaker.ts";
import { prepareClefImages, type ImageRefusal, type ImageShrinker, type ImageSource } from "./clef-images.ts";

export const FAST_DECIDE_BUDGET_MS = 1_500;

export type FastFallback = DeciderFailure | ImageRefusal | "no_decider" | "circuit_open";

export type FastDecision<A> =
  | { decided: true; answers: A; latencyMs: number; model?: string }
  | { decided: false; reason: FastFallback; latencyMs?: number };

export interface FastDecideOptions extends Omit<AskOptions, "images"> {
  budgetMs?: number;
  images?: readonly ImageSource[];
  shrink?: ImageShrinker;
  breaker?: Breaker;
}

const MIN_BUDGET_MS = 50;

export async function fastDecide<Qs extends Record<string, DeciderQuestion>>(
  decider: Pick<Decider, "ask"> | undefined,
  seam: DeciderSeam,
  state: unknown,
  questions: Qs,
  options: FastDecideOptions = {},
): Promise<FastDecision<Answers<Qs>>> {
  if (!decider) return { decided: false, reason: "no_decider" };
  const { budgetMs, images, shrink, breaker, ...rest } = options;
  if (breaker && !breaker.allow(seam)) return { decided: false, reason: "circuit_open" };
  const budget = Math.max(MIN_BUDGET_MS, budgetMs ?? rest.timeoutMs ?? FAST_DECIDE_BUDGET_MS);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<FastDecision<Answers<Qs>>>((resolve) => {
    timer = setTimeout(() => resolve({ decided: false, reason: "timeout", latencyMs: budget }), budget);
  });
  const work = (async (): Promise<FastDecision<Answers<Qs>>> => {
    let prepared: string[] | undefined;
    if (images?.length) {
      const result = await prepareClefImages(images, { shrink });
      if (!result.ok) return { decided: false, reason: result.reason };
      prepared = result.images;
    }
    const answered = await decider.ask(seam, state, questions, {
      ...rest,
      timeoutMs: Math.max(MIN_BUDGET_MS, budget - (Date.now() - started)),
      ...(prepared ? { images: prepared } : {}),
    });
    if (!answered.ok) return { decided: false, reason: answered.reason, ...(answered.latencyMs !== undefined ? { latencyMs: answered.latencyMs } : {}) };
    return { decided: true, answers: answered.answers, latencyMs: answered.latencyMs, ...(answered.model ? { model: answered.model } : {}) };
  })().catch((): FastDecision<Answers<Qs>> => ({ decided: false, reason: "malformed" }));
  try {
    const outcome = await Promise.race([work, expired]);
    breaker?.report(seam, outcome.decided ? { ok: true } : { ok: false, reason: outcome.reason });
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

export function yes(answer: YesNoAnswer | undefined, atLeast: number): boolean {
  return answer !== undefined && answer.p >= atLeast;
}

export function chosen<K extends string>(answer: ChoiceAnswer<K> | undefined, atLeast: number): K | null {
  return answer !== undefined && answer.pTop >= atLeast ? answer.choice : null;
}
