import type { NativeActivity, NativeActor, NativeActorState, NativeObservation, NativeRun } from "./native-runs.ts";
import type { RuntimeEvent } from "./runtime-events.ts";

export const nativeTextLimit = 24_000;

export interface NativeProjectionEvent {
  id: string;
  turnId: string;
  eventId: string;
  at: number;
  type: RuntimeEvent["type"];
  botId?: string;
  parentLabel?: string;
  provider: string;
  providerInstanceId?: string;
  sequence?: number;
  sessionId?: string;
  helpers?: NativeActor[];
  observation?: NativeObservation;
  result?: "done" | "stopped" | "failed";
}

const terminal = (state: NativeActorState): boolean => state === "done" || state === "failed" || state === "stopped";

function updateActor(run: NativeRun, incoming: NativeActor): void {
  const index = run.actors.findIndex(actor => actor.id === incoming.id);
  const previous = run.actors[index];
  if (previous && terminal(previous.state) && previous.state !== incoming.state && previous.generation === incoming.generation) return;
  if (incoming.state === "failed" && previous?.state !== "failed") run.failureCount += 1;
  if (index >= 0) run.actors[index] = { ...previous, ...incoming, label: incoming.id === "parent" ? previous.label : incoming.label, startedAt: previous.generation === incoming.generation ? previous.startedAt : incoming.startedAt };
  else if (run.actors.length < 128) run.actors.push(incoming);
  else run.truncated = true;
}

export function projectNativeEvent(threadId: string, event: NativeProjectionEvent, previous: NativeRun | undefined, item: (id: string) => NativeActivity | undefined): { run: NativeRun; activity?: NativeActivity } {
  const { id, at, observation } = event;
  const next: NativeRun = previous ?? { id, threadId, turnId: event.turnId, botId: event.botId, provider: event.provider,
    providerInstanceId: event.providerInstanceId, revision: 0, startedAt: at, state: "running", observation: "live", activityCount: 0, failureCount: 0, limitations: [],
    actors: [{ id: "parent", kind: "parent", label: event.parentLabel ?? "Main agent", state: "running", startedAt: at }],
  };
  next.revision += 1;
  let activity: NativeActivity | undefined;
  if (event.type === "session.started") next.sessionId = event.sessionId ?? undefined;
  if (event.type === "native.observed") {
    if (!next.nativeActivity) next.actors = next.actors.filter(actor => !actor.id.startsWith("legacy:"));
    next.nativeActivity = true;
  }
  if (event.type === "helper.updated" && !next.nativeActivity) {
    for (const helper of event.helpers ?? []) updateActor(next, helper);
  }
  if (observation?.kind === "actor") updateActor(next, observation.actor);
  if (observation?.kind === "capabilities") {
    next.providerVersion = observation.version ?? next.providerVersion;
    next.limitations = [...new Set([...next.limitations, ...observation.limitations])];
    next.nativeParentActivity = observation.handlesParentActivity ?? next.nativeParentActivity;
  }
  const coveredParentItem = next.nativeParentActivity && event.type !== "native.observed" && (event.type.startsWith("item.") || event.type === "content.delta");
  if (observation?.kind === "activity" && !coveredParentItem) {
    const before = item(observation.activity.id);
    const incoming = observation.activity;
    if (!before || !terminal(before.state) || before.state === incoming.state) {
      activity = { ...before, ...incoming, startedAt: before?.startedAt ?? incoming.startedAt };
      if (before && event.type !== "native.observed") { activity.label = before.label; activity.kind = before.kind; }
      if (observation.append) {
        const field = observation.append;
        const full = (before?.[field] ?? "") + (incoming[field] ?? "");
        activity[field] = full.slice(0, nativeTextLimit);
        activity.truncated ||= full.length > nativeTextLimit;
      }
      if (!before) next.activityCount += 1;
      if (incoming.state === "failed" && before?.state !== "failed") next.failureCount += 1;
    }
  }
  if (event.type === "turn.completed") {
    next.endedAt = at;
    next.state = event.result!;
    next.observation = next.actors.some(actor => actor.id !== "parent" && !actor.ambient && !terminal(actor.state)) ? "partial" : "complete";
    next.actors = next.actors.map(actor => actor.id === "parent" ? { ...actor, state: next.state, endedAt: at, canStop: false } : { ...actor, canStop: false });
  }
  if (event.type === "session.exited" && !next.endedAt) {
    next.observation = "interrupted";
    next.actors = next.actors.map(actor => ({ ...actor, canStop: false }));
  }
  if (next.endedAt && (next.observation === "partial" || next.observation === "complete")) next.observation = next.actors.some(actor => actor.id !== "parent" && !actor.ambient && !terminal(actor.state)) ? "partial" : "complete";
  return { run: next, activity };
}
