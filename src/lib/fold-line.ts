import type { Message } from "@/state/store";
import type { NativeRun } from "../../shared/native-runs";
import { failedTurnCause } from "../../shared/failed-turn";
import { foldSentence, outcomeKindOfTool, type OutcomeKind } from "../../shared/step-words";
import { isStatusActivity } from "./activity-runs";

export interface TurnFold {
  turnId: string;
  anchorId: string;
  sentence: string;
  runId?: string;
}

function counted(message: Message): OutcomeKind | null {
  const name = message.kind === "activity" ? message.tool?.name : undefined;
  if (!name || message.comm || message.threadRef || message.cloudTask || isStatusActivity(message)) return null;
  if (failedTurnCause(name) !== null) return null;
  const kind = outcomeKindOfTool(name);
  return kind === "plan" ? null : kind;
}

export function turnFolds(messages: readonly Message[], runs: readonly NativeRun[]): Map<string, TurnFold> {
  const counts = new Map<string, Partial<Record<OutcomeKind, number>>>();
  const anchors = new Map<string, string>();
  for (const message of messages) {
    const turnId = message.turnId;
    if (!turnId) continue;
    if (message.role === "bot" && message.kind === "text" && message.turnTerminal) anchors.set(turnId, message.id);
    const kind = counted(message);
    if (!kind) continue;
    const tally = counts.get(turnId) ?? {};
    tally[kind] = (tally[kind] ?? 0) + 1;
    counts.set(turnId, tally);
  }
  const folds = new Map<string, TurnFold>();
  for (const [turnId, anchorId] of anchors) {
    const sentence = foldSentence(counts.get(turnId) ?? {});
    if (!sentence) continue;
    const run = runs.find(candidate => candidate.turnId === turnId && (candidate.endedAt || candidate.observation !== "live"));
    folds.set(anchorId, { turnId, anchorId, sentence, ...(run ? { runId: run.id } : {}) });
  }
  return folds;
}
