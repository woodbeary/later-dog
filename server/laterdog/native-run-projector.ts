import { createHash } from "node:crypto";
import type { NativeActivity, NativeActor, NativeActorState, NativeObservation, NativeRun } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { Helper, HelpersSnapshot } from "../../shared/helpers.ts";
import { redactSecrets } from "../redact.ts";
import { NativeRunStore } from "./native-run-store.ts";

const terminal = (state: NativeActorState): boolean => state === "done" || state === "failed" || state === "stopped";
const active = (state: NativeActorState): boolean => state === "running" || state === "waiting";
const textLimit = 24_000;
const clip = (value: string | undefined, limit = textLimit): string | undefined => value?.slice(0, limit);
const publicLink = (value: string): boolean => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password; }
  catch { return false; }
};
export const nativeRunId = (threadId: string, providerInstanceId: string, turnId: string): string =>
  createHash("sha256").update(JSON.stringify([threadId, providerInstanceId, turnId])).digest("hex").slice(0, 32);

function cleanObservation(observation: NativeObservation): NativeObservation {
  const clean = redactSecrets(observation) as NativeObservation;
  if (clean.kind === "actor") return { kind: "actor", actor: { ...clean.actor, label: clip(clean.actor.label, 160)!, task: clip(clean.actor.task), summary: clip(clean.actor.summary), activity: clip(clean.actor.activity, 500) } };
  if (clean.kind === "capabilities") return { ...clean, limitations: clean.limitations.slice(0, 30).map(line => clip(line, 1000)!) };
  const a = clean.activity;
  return { ...clean, activity: { ...a, label: clip(a.label, 250)!, input: clip(a.input), output: clip(a.output), text: clip(a.text),
    truncated: a.truncated || [a.input, a.output, a.text].some(value => (value?.length ?? 0) > textLimit),
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
    const run = this.store.apply(id, event.eventId, at, observation ?? { type: event.type }, (previous, item) => {
      const owner = this.owner(event.threadId);
      const next: NativeRun = previous ?? { id, threadId: event.threadId, turnId, botId: owner.botId, provider: event.provider,
        providerInstanceId: event.providerInstanceId, revision: 0, startedAt: at, state: "running", observation: "live", activityCount: 0, failureCount: 0, limitations: [],
        actors: [{ id: "parent", kind: "parent", label: owner.label ?? "Main agent", state: "running", startedAt: at }],
      };
      next.revision += 1;
      let activity: NativeActivity | undefined;
      if (event.type === "session.started") next.sessionId = event.sessionId ?? undefined;
      if (event.type === "native.observed") {
        if (!next.nativeActivity) next.actors = next.actors.filter(actor => !actor.id.startsWith("legacy:"));
        next.nativeActivity = true;
      }
      if (event.type === "helper.updated" && !next.nativeActivity) {
        const helper = event.helper;
        this.actor(next, { id: `legacy:${helper.id}`, parentId: "parent", nativeId: helper.id, kind: helper.kind === "workflow" ? "workflow" : "subagent", label: helper.label, state: helper.state, activity: helper.activity, summary: helper.summary, startedAt: helper.startedAt, endedAt: helper.endedAt, background: helper.background });
        for (const member of helper.members ?? []) this.actor(next, { id: `legacy:${helper.id}:${member.id}`, parentId: `legacy:${helper.id}`, kind: "subagent", label: member.label, state: member.state, activity: member.activity, startedAt: helper.startedAt });
      }
      if (observation?.kind === "actor") this.actor(next, observation.actor);
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
            activity[field] = clip(full);
            activity.truncated ||= full.length > textLimit;
          }
          if (!before) next.activityCount += 1;
          if (incoming.state === "failed" && before?.state !== "failed") next.failureCount += 1;
        }
      }
      if (event.type === "turn.completed") {
        next.endedAt = at;
        next.state = event.ok ? "done" : /interrupt|cancel|stop/i.test(event.stopReason ?? "") ? "stopped" : "failed";
        next.observation = next.actors.some(actor => actor.id !== "parent" && !actor.ambient && !terminal(actor.state)) ? "partial" : "complete";
        next.actors = next.actors.map(actor => actor.id === "parent" ? { ...actor, state: next.state, endedAt: at, canStop: false } : { ...actor, canStop: false });
      }
      if (event.type === "session.exited" && !next.endedAt) {
        next.observation = "interrupted";
        next.actors = next.actors.map(actor => ({ ...actor, canStop: false }));
      }
      if (next.endedAt && (next.observation === "partial" || next.observation === "complete")) next.observation = next.actors.some(actor => actor.id !== "parent" && !actor.ambient && !terminal(actor.state)) ? "partial" : "complete";
      return { run: next, activity };
    });
    if (run) {
      const current = this.current(event.threadId);
      if (!current || run.startedAt >= current.startedAt) this.latest.set(event.threadId, id);
      this.publish(run);
    }
    return run;
  }

  private actor(run: NativeRun, incoming: NativeActor): void {
    const cleaned = cleanObservation({ kind: "actor", actor: incoming });
    if (cleaned.kind !== "actor") return;
    incoming = cleaned.actor;
    const index = run.actors.findIndex(actor => actor.id === incoming.id);
    const previous = run.actors[index];
    if (previous && terminal(previous.state) && previous.state !== incoming.state && previous.generation === incoming.generation) return;
    if (incoming.state === "failed" && previous?.state !== "failed") run.failureCount += 1;
    if (index >= 0) run.actors[index] = { ...previous, ...incoming, startedAt: previous.generation === incoming.generation ? previous.startedAt : incoming.startedAt };
    else if (run.actors.length < 128) run.actors.push(incoming);
    else run.truncated = true;
  }

  running(threadId: string): boolean {
    const run = this.current(threadId);
    return run?.observation === "live" && run.actors.some(actor => actor.kind !== "parent" && !actor.ambient && active(actor.state));
  }

  current(threadId: string): NativeRun | undefined {
    const id = this.latest.get(threadId);
    return id ? this.store.get(id) : this.store.list(threadId, undefined, 1).runs[0];
  }

  interrupt(threadId: string, reason: string): void {
    const current = this.current(threadId);
    if (!current || current.observation !== "live") return;
    const at = Date.now();
    const run = this.store.apply(current.id, `interrupted:${current.revision}`, at, { reason }, previous => ({
      run: { ...previous!, observation: "interrupted", revision: previous!.revision + 1, actors: previous!.actors.map(actor => ({ ...actor, canStop: false })) },
      activity: { id: "observation-interrupted", actorId: "parent", kind: "notice", label: "Activity interrupted", text: reason, state: "stopped", startedAt: at, endedAt: at },
    }));
    if (run) this.publish(run);
  }

  snapshot(visible: (threadId: string) => boolean): HelpersSnapshot {
    const helpers: Record<string, Helper[]> = {};
    for (const [threadId, id] of this.latest) {
      if (!visible(threadId)) continue;
      const run = this.store.get(id);
      if (!run || (run.endedAt && Date.now() - run.endedAt > 10_000)) continue;
      helpers[threadId] = run.actors.filter(actor => actor.kind === "subagent" || actor.kind === "workflow").map(actor => ({
        id: actor.id, kind: actor.kind === "workflow" ? "workflow" : "agent", label: actor.label, state: actor.state === "paused" ? "stopped" : actor.state === "waiting" ? "running" : actor.state,
        background: actor.background ?? false, startedAt: actor.startedAt, endedAt: actor.endedAt, activity: actor.activity, summary: actor.summary,
      }));
    }
    return { helpers };
  }
}
