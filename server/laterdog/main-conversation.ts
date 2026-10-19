import { readFileSync } from "node:fs";

export interface ConversationCandidate {
  threadId: string;
  createdAt: number;
  archivedAt?: number;
  routineRunId?: string;
}

export interface ConversationEvidence {
  lastWrittenByPerson: ReadonlyMap<string, number>;
  madeForRoutineRun: (thread: ConversationCandidate) => boolean;
}

export interface SavedRoutineRun {
  threadId: string;
  startedAt: number;
  sourceThreadId?: string;
  resultsThreadId?: string;
}

export function mainConversation(
  current: string,
  threads: readonly ConversationCandidate[],
  evidence: ConversationEvidence,
): string {
  const pointed = threads.find((thread) => thread.threadId === current);
  if (!pointed) return current;
  const candidates = threads.filter((thread) =>
    thread.archivedAt === undefined && !thread.routineRunId && !evidence.madeForRoutineRun(thread));
  const written = (thread: ConversationCandidate) => evidence.lastWrittenByPerson.get(thread.threadId);
  if (candidates.includes(pointed) && written(pointed) !== undefined) return current;
  const lastWritten = candidates.reduce<ConversationCandidate | undefined>((best, thread) => {
    const at = written(thread);
    if (at === undefined) return best;
    return !best || at > written(best)! ? thread : best;
  }, undefined);
  if (lastWritten) return lastWritten.threadId;
  const oldest = candidates.reduce<ConversationCandidate | undefined>((best, thread) =>
    !best || thread.createdAt < best.createdAt || (thread.createdAt === best.createdAt && thread === pointed) ? thread : best, undefined);
  return oldest?.threadId ?? current;
}

export function madeForRoutineRun(runs: readonly SavedRoutineRun[]): (thread: ConversationCandidate) => boolean {
  const starts = new Map<string, number[]>();
  for (const run of runs) {
    if (run.threadId === run.sourceThreadId || run.threadId === run.resultsThreadId) continue;
    starts.set(run.threadId, [...(starts.get(run.threadId) ?? []), run.startedAt]);
  }
  return (thread) => (starts.get(thread.threadId) ?? []).some((startedAt) => thread.createdAt >= startedAt);
}

export function savedRoutineRuns(file: string): SavedRoutineRun[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const runs = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { runs?: unknown }).runs : undefined;
  if (!Array.isArray(runs)) return [];
  const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
  return runs.flatMap((run): SavedRoutineRun[] => {
    if (!run || typeof run !== "object") return [];
    const { threadId, startedAt, sourceThreadId, resultsThreadId } = run as Record<string, unknown>;
    const thread = text(threadId);
    if (!thread || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return [];
    const source = text(sourceThreadId);
    const results = text(resultsThreadId);
    return [{ threadId: thread, startedAt, ...(source ? { sourceThreadId: source } : {}), ...(results ? { resultsThreadId: results } : {}) }];
  });
}
