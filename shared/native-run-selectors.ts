import type { NativeActor, NativeRun } from "./native-runs.ts";

export const NATIVE_PUPPY_LIMIT = 5;

export type NativeActorRole = "main" | "puppy" | "workflow" | "task";

export const nativeActorRole = (actor: Pick<NativeActor, "kind">): NativeActorRole =>
  actor.kind === "parent" ? "main" : actor.kind === "subagent" ? "puppy" : actor.kind === "workflow" ? "workflow" : "task";

export const nativePuppies = (run: NativeRun): NativeActor[] => run.actors.filter(actor => actor.kind === "subagent");

export function actorAncestry(run: NativeRun, actor: NativeActor): NativeActor[] {
  const parents: NativeActor[] = [];
  const seen = new Set([actor.id]);
  let parentId = actor.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = run.actors.find(row => row.id === parentId);
    if (!parent) break;
    parents.unshift(parent);
    parentId = parent.parentId;
  }
  return parents;
}

export function applyNativeRun(runs: readonly NativeRun[], incoming: NativeRun): readonly NativeRun[] {
  if (!incoming?.id || !incoming.threadId || !Array.isArray(incoming.actors)) return runs;
  const index = runs.findIndex(row => row.id === incoming.id);
  const existing = runs[index];
  if (existing && existing.revision >= incoming.revision) return runs;
  const next = [...runs];
  if (index === -1) next.push(incoming);
  else next[index] = incoming;
  if (existing?.startedAt !== incoming.startedAt) next.sort((a, b) => b.startedAt - a.startedAt);
  return next;
}

export interface NativeReceiptMessage { id: string; turnId?: string; role: string; kind: string }

export function nativeReceiptAnchors(runs: readonly NativeRun[], messages: readonly NativeReceiptMessage[]): Map<string, NativeRun[]> {
  const anchors = new Map<string, NativeRun[]>();
  const answers = new Map<string, string>();
  for (const message of messages) if (message.turnId && message.role !== "user" && message.kind === "text") answers.set(message.turnId, message.id);
  for (const run of runs) {
    if (!run.endedAt && run.observation === "live") continue;
    const anchor = answers.get(run.turnId);
    if (anchor) anchors.set(anchor, [...(anchors.get(anchor) ?? []), run]);
  }
  return anchors;
}

export interface NativeExecutionSelection { instanceId?: string; model?: string }

export interface NativeExecutionComparison {
  running: { providerInstanceId?: string; model?: string };
  selected: NativeExecutionSelection;
  status: "same" | "next-message" | "unknown";
}

export function nativeExecutionComparison(run: NativeRun, selected: NativeExecutionSelection | undefined): NativeExecutionComparison | undefined {
  if (!selected || run.observation !== "live") return undefined;
  const running = { providerInstanceId: run.providerInstanceId, model: run.actors.find(actor => actor.id === "parent")?.model };
  const comparable = [
    [running.providerInstanceId, selected.instanceId],
    [running.model, selected.model],
  ].filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]));
  if (!comparable.length) return { running, selected, status: "unknown" };
  return { running, selected, status: comparable.every(([actual, wanted]) => actual === wanted) ? "same" : "next-message" };
}
