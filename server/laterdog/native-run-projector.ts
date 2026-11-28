import { createHash } from "node:crypto";
import type { NativeActivity, NativeActor, NativeActorState, NativeObservation, NativeRun } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { Helper, HelpersSnapshot } from "../../shared/helpers.ts";
import { redactSecrets } from "../redact.ts";
import { nativeTextLimit } from "../../shared/native-run-projection.ts";
import { NativeRunStore } from "./native-run-store.ts";

const active = (state: NativeActorState): boolean => state === "running" || state === "waiting";

const clip = (value: string | undefined, limit = nativeTextLimit): string | undefined => value?.slice(0, limit);
const publicLink = (value: string): boolean => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password; }
  catch { return false; }
};
export const nativeRunId = (threadId: string, providerInstanceId: string, turnId: string): string =>
  createHash("sha256").update(JSON.stringify([threadId, providerInstanceId, turnId])).digest("hex").slice(0, 32);

function legacyActors(event: Extract<RuntimeEvent, { type: "helper.updated" }>): NativeActor[] {
  const actors: NativeActor[] = [];
  const helper = event.helper;
  actors.push({ id: `legacy:${helper.id}`, parentId: "parent", nativeId: helper.id, kind: helper.kind === "workflow" ? "workflow" : "subagent", label: helper.label, state: helper.state, activity: helper.activity, summary: helper.summary, startedAt: helper.startedAt, endedAt: helper.endedAt, background: helper.background });
  for (const member of helper.members ?? []) actors.push({ id: `legacy:${helper.id}:${member.id}`, parentId: `legacy:${helper.id}`, kind: "subagent", label: member.label, state: member.state, activity: member.activity, startedAt: helper.startedAt });
  return actors.map(cleanActor);
}

function cleanActor(actor: NativeActor): NativeActor {
  const clean = redactSecrets(actor) as NativeActor;
  return { ...clean, label: clip(clean.label, 160)!, task: clip(clean.task, 4_000), summary: clip(clean.summary, 4_000), activity: clip(clean.activity, 500) };
}

function cleanObservation(observation: NativeObservation): NativeObservation {
  if (observation.kind === "actor") return { kind: "actor", actor: cleanActor(observation.actor) };
  const clean = redactSecrets(observation) as Exclude<NativeObservation, { kind: "actor" }>;
  if (clean.kind === "capabilities") return { ...clean, limitations: clean.limitations.slice(0, 30).map(line => clip(line, 1000)!) };
  const a = clean.activity;
  return { ...clean, activity: { ...a, label: clip(a.label, 250)!, input: clip(a.input), output: clip(a.output), text: clip(a.text),
    truncated: a.truncated || [a.input, a.output, a.text].some(value => (value?.length ?? 0) > nativeTextLimit),
    links: a.links?.filter(link => publicLink(link.url)).slice(0, 50).map(link => ({ title: clip(link.title, 250)!, url: clip(link.url, 2000)! })),
  } };
}

function activityKind(title: string): NativeActivity["kind"] {
  return /web.?search|web.?fetch|search.?web|open.?page|find.?in.?page/i.test(title) ? "search" : "tool";
}

function parentObservation(event: RuntimeEvent, at: number): NativeObservation | undefined {
  const id = event.itemId ?? event.requestId ?? event.eventId;
  const actorId = event.nativeActorId ?? "parent";
  switch (event.type) {
    case "item.started": return { kind: "activity", activity: { id, actorId, kind: event.itemType === "reasoning" ? "reasoning" : activityKind(event.title ?? ""), label: event.title ?? (event.itemType === "reasoning" ? "Thinking" : "Using a tool"), state: "running", startedAt: at, input: event.input, text: event.summary } };
    case "item.completed":
      if (event.itemType === "assistant_image") return;
      return { kind: "activity", activity: { id, actorId, kind: event.itemType === "tool" ? "tool" : "message", label: event.itemType === "tool" ? "Tool result" : "Reply", state: event.itemType === "tool" && !event.ok ? "failed" : "done", startedAt: at, endedAt: at, ...(event.itemType === "tool" ? { output: event.output } : { text: event.text }) } };
    case "content.delta":
      if (event.streamKind !== "reasoning_text" || !event.summary) return;
      return { kind: "activity", append: "text", activity: { id: event.itemId ?? "parent-reasoning", actorId, kind: "reasoning", label: "Thinking", state: "running", startedAt: at, text: event.delta } };
    case "request.opened": return { kind: "activity", activity: { id: `request:${id}`, actorId, kind: "request", label: event.summary, input: event.tool, state: "waiting", startedAt: at, requestId: event.requestId } };
    case "request.resolved": return { kind: "activity", activity: { id: `request:${id}`, actorId, kind: "request", label: "Request resolved", state: event.behavior === "deny" ? "stopped" : "done", startedAt: at, endedAt: at, requestId: event.requestId, output: event.behavior } };
    case "turn.retrying": return { kind: "activity", activity: { id: `retry:${event.attempt}`, actorId, kind: "notice", label: "Retrying", text: event.reason, state: "running", startedAt: at } };
    case "runtime.error": return { kind: "activity", activity: { id, actorId, kind: "notice", label: "Runtime error", text: event.message, state: "failed", startedAt: at, endedAt: at } };
    case "runtime.notice": return { kind: "activity", activity: { id, actorId, kind: "notice", label: "Runtime notice", text: event.message, state: "done", startedAt: at, endedAt: at } };
    default: return;
  }
}

export class NativeRunProjector {
  private readonly latest = new Map<string, string>();
  readonly store: NativeRunStore;
  private readonly publish: (run: NativeRun) => void;
  private readonly owner: (threadId: string) => { botId?: string; label?: string };
  constructor(store: NativeRunStore, publish: (run: NativeRun) => void, owner: (threadId: string) => { botId?: string; label?: string } = () => ({})) {
    this.store = store;
    this.publish = publish;
    this.owner = owner;
  }

  observe(event: RuntimeEvent): NativeRun | undefined {
    const turnId = event.turnId;
    if (!turnId) return;
    const id = nativeRunId(event.threadId, event.providerInstanceId ?? event.provider, turnId);
    const timestamp = Date.parse(event.createdAt);
    const at = Number.isFinite(timestamp) ? timestamp : Date.now();
    const rawObservation = event.type === "native.observed" ? event.observation : parentObservation(event, at);
    const observation = rawObservation ? cleanObservation(rawObservation) : undefined;
    if (!observation && !["turn.started", "turn.completed", "session.started", "helper.updated", "session.exited"].includes(event.type)) return;
    const owner = this.owner(event.threadId);
    const run = this.store.observe(event.threadId, {
      id, turnId, eventId: event.eventId, at, type: event.type, provider: event.provider,
      providerInstanceId: event.providerInstanceId, sequence: event.nativeSequence,
      botId: owner.botId, parentLabel: owner.label, observation,
      sessionId: event.type === "session.started" ? event.sessionId ?? undefined : undefined,
      helpers: event.type === "helper.updated" ? legacyActors(event) : undefined,
      result: event.type === "turn.completed" ? (event.ok ? "done" : /interrupt|cancel|stop/i.test(event.stopReason ?? "") ? "stopped" : "failed") : undefined,
    });
    if (run) {
      const current = this.latest.get(event.threadId) === id ? run : this.current(event.threadId);
      if (!current || run.startedAt >= current.startedAt) this.latest.set(event.threadId, id);
      this.publish(run);
    }
    return run;
  }

  forEvent(event: Pick<RuntimeEvent, "threadId" | "providerInstanceId" | "provider" | "turnId">): NativeRun | undefined {
    return event.turnId ? this.store.get(nativeRunId(event.threadId, event.providerInstanceId ?? event.provider, event.turnId), event.threadId) : undefined;
  }

  running(threadId: string, event?: RuntimeEvent): boolean {
    const runs = event ? [this.forEvent(event)] : this.store.live(threadId);
    return runs.some(run => run?.observation === "live" && run.actors.some(actor => actor.kind !== "parent" && !actor.ambient && active(actor.state)));
  }

  runningCount(threadId: string): number {
    return this.store.live(threadId).reduce((total, run) => total + (run.observation === "live" ? run.actors.filter(actor => actor.kind !== "parent" && !actor.ambient && active(actor.state)).length : 0), 0);
  }

  current(threadId: string): NativeRun | undefined {
    const id = this.latest.get(threadId);
    return (id ? this.store.get(id, threadId) : undefined) ?? this.store.list(threadId, undefined, 1).runs[0];
  }

  interrupt(threadId: string, reason: string): void {
    for (const current of this.store.live(threadId)) {
      const at = Date.now();
      const run = this.store.interrupt(threadId, current.id, current.revision, at, reason);
      if (run) this.publish(run);
    }
  }

  snapshot(visible: (threadId: string) => boolean): HelpersSnapshot {
    const helpers: Record<string, Helper[]> = {};
    for (const [threadId, id] of this.latest) {
      if (!visible(threadId)) continue;
      const current = this.store.get(id, threadId);
      const runs = this.store.live(threadId);
      if (current && current.observation !== "live" && current.endedAt && Date.now() - current.endedAt <= 10_000) runs.push(current);
      helpers[threadId] = runs.flatMap(run => run.actors.filter(actor => actor.kind === "subagent" || actor.kind === "workflow").map(actor => ({
        id: `${run.id}:${actor.id}`, kind: actor.kind === "workflow" ? "workflow" : "agent", label: actor.label, state: actor.state === "paused" ? "stopped" : actor.state === "waiting" ? "running" : actor.state,
        background: actor.background ?? false, startedAt: actor.startedAt, endedAt: actor.endedAt, activity: actor.activity, summary: actor.summary,
      })));
    }
    return { helpers };
  }
}
