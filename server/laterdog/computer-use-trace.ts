import { createHash } from "node:crypto";
import type { ComputerUseRun, Handoff, LoggedStep } from "./computer-use-store.ts";

export const TRACE_VERSION = 1;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface HashedTrace {
  version: number;
  run: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  handoffs: Array<Record<string, unknown>>;
}

export function hashedTrace(view: { run: ComputerUseRun; steps: LoggedStep[]; handoffs: Handoff[] }): HashedTrace {
  const { run } = view;
  return {
    version: TRACE_VERSION,
    run: {
      id: run.id, startedAt: run.startedAt, endedAt: run.endedAt, model: run.model, state: run.state, doneSource: run.doneSource, failure: run.failure,
      screenChecks: run.screenChecks, taskSha256: sha256(run.task), done: { pageCheck: run.done.pageCheck !== null, stateCheck: Boolean(run.done.stateCheck) },
    },
    steps: view.steps.map((step) => ({
      step: step.step, at: step.at, actions: step.actions, screenshotSha256: step.screenshotSha256, modelMs: step.modelMs, actionMs: step.actionMs,
      inputTokens: step.inputTokens, outputTokens: step.outputTokens, cacheReadTokens: step.cacheReadTokens, cacheWriteTokens: step.cacheWriteTokens,
      screenState: step.screenState, screenProbability: step.screenProbability, outcome: step.outcome, screenUnchanged: step.screenUnchanged,
      failureClass: step.failureClass, thinkingSha256: step.thinking === null ? null : sha256(step.thinking),
    })),
    handoffs: view.handoffs.map((handoff) => ({
      number: handoff.number, at: handoff.at, returnedAt: handoff.returnedAt, cause: handoff.cause, askedBy: handoff.askedBy,
      probability: handoff.probability, noteSha256: sha256(handoff.note),
    })),
  };
}
