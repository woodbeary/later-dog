import type { Decider } from "../decider/index.ts";
import type {
  Answers, AskOptions, ChoiceAnswer, DeciderAnswer, DeciderFailure, DeciderQuestion, DeciderResult, DeciderSeam, ScoreAnswer, YesNoAnswer,
} from "../decider/types.ts";

export interface FakeCall {
  seam: DeciderSeam;
  state: unknown;
  questions: Record<string, DeciderQuestion>;
  options: AskOptions;
}

export type FakeReply =
  | { answers: Record<string, DeciderAnswer>; delayMs?: number; reportedMs?: number }
  | { fail: DeciderFailure; delayMs?: number; reportedMs?: number }
  | { hang: true };

export type FakeScript = (call: FakeCall, index: number) => FakeReply;

export interface FakeDecider extends Pick<Decider, "ask"> {
  calls: FakeCall[];
}

export const yesAnswer = (p: number): YesNoAnswer => ({ type: "yesno", p });

export function choiceAnswer<K extends string>(choice: K, pTop: number, others: readonly K[] = []): ChoiceAnswer<K> {
  const rest = others.filter((key) => key !== choice);
  const share = rest.length ? (1 - pTop) / rest.length : 0;
  const probabilities = Object.fromEntries([[choice, pTop], ...rest.map((key) => [key, share])]) as Partial<Record<K, number>>;
  return { type: "choice", choice, pTop, margin: pTop - (rest.length ? share : 0), probabilities };
}

export function scoreAnswer(level: number, levels: number): ScoreAnswer {
  const probabilities = Array.from({ length: levels }, (_, index) => (index === level ? 1 : 0));
  return { type: "score", score: level, level, probabilities };
}

export function fakeDecider(script: FakeScript): FakeDecider {
  const calls: FakeCall[] = [];
  return {
    calls,
    async ask<Qs extends Record<string, DeciderQuestion>>(
      seam: DeciderSeam,
      state: unknown,
      questions: Qs,
      options: AskOptions = {},
    ): Promise<DeciderResult<Answers<Qs>>> {
      const call: FakeCall = { seam, state, questions, options };
      const reply = script(call, calls.length);
      calls.push(call);
      if ("hang" in reply) {
        const budget = options.timeoutMs ?? 1_500;
        await new Promise((resolve) => setTimeout(resolve, budget));
        return { ok: false, provider: "jev", reason: "timeout", latencyMs: budget };
      }
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      if ("fail" in reply) return { ok: false, provider: "jev", reason: reply.fail, latencyMs: reply.reportedMs ?? reply.delayMs ?? 0 };
      return { ok: true, provider: "jev", answers: reply.answers as Answers<Qs>, latencyMs: reply.reportedMs ?? reply.delayMs ?? 0 };
    },
  };
}
