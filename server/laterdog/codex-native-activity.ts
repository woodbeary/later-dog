import type { NativeActor, NativeActorState, NativeActivity, NativeActivityKind, NativeObservation } from "../../shared/native-runs.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const text = (value: unknown): string | undefined => string(value)?.slice(0, 24_000);
const terminal = (state: NativeActorState) => state === "done" || state === "failed" || state === "stopped";
const stateOf = (status: unknown, fallback: NativeActorState = "running"): NativeActorState => status === "completed" ? "done" : status === "failed" || status === "errored" || status === "notFound" || status === "declined" ? "failed" : status === "interrupted" || status === "shutdown" || status === "stopped" ? "stopped" : status === "blocked" ? "waiting" : fallback;
const printable = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  try { return text(typeof value === "string" ? value : JSON.stringify(value)); } catch { return undefined; }
};
const lines = (value: unknown) => Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("\n") : undefined;

interface OwnedThread { actor: NativeActor; retiredTurns: Set<string>; generation: number }
export type CodexActorTarget = Pick<NativeActor, "id" | "nativeThreadId" | "nativeTurnId" | "generation">;

export class CodexNativeActivity {
  private rootThread?: string;
  private rootTurn?: string;
  private threads = new Map<string, OwnedThread>();
  private activities = new Map<string, NativeActivity>();
  private pending: unknown[] = [];
  private sequence = 0;
  private capacityNoted = false;
  private ended = false;
  private readonly emit: (event: NativeObservation) => void;
  private readonly now: () => number;
  constructor(emit: (event: NativeObservation) => void, now: () => number = Date.now) {
    this.emit = emit;
    this.now = now;
  }

  capabilities(version?: string): void {
    this.emit({ kind: "capabilities", handlesParentActivity: true, ...(version ? { version } : {}), limitations: [
      "Native helpers stop when the parent turn ends.",
      "Native helper activity is observed while this turn is connected; earlier native history is not imported.",
      "Native helpers cannot receive direct messages here.",
      "Unrecognized native activity is shown as a notice; general MCP forms are not supported.",
      "Activity previews are bounded; truncated details are marked.",
    ] });
  }

  start(threadId: string, turnId: string): void {
    this.rootThread = threadId;
    this.rootTurn = turnId;
    this.put(threadId, { id: "parent", kind: "parent", label: "Codex", state: "running", nativeThreadId: threadId, nativeTurnId: turnId, generation: turnId, startedAt: this.now(), canStop: false });
    for (const message of this.pending.splice(0)) this.receive(message);
  }

  actorFor(params: unknown, allowLegacy = false): NativeActor | undefined {
    const p = record(params);
    const id = string(p.threadId) ?? (allowLegacy ? this.rootThread : undefined);
    if (!id) return undefined;
    const owned = this.threads.get(id);
    const turnId = string(p.turnId);
    if (!owned || (turnId && owned.actor.nativeTurnId && turnId !== owned.actor.nativeTurnId)) return undefined;
    return owned.actor;
  }

  stopTarget(target: CodexActorTarget): { threadId: string; turnId: string } {
    const owned = target.nativeThreadId ? this.threads.get(target.nativeThreadId) : [...this.threads.values()].find(value => value.actor.id === target.id);
    const actor = owned?.actor;
    if (this.ended || !actor || actor.kind === "parent" || actor.id !== target.id || !actor.canStop || !actor.nativeThreadId || !actor.nativeTurnId ||
      (target.nativeTurnId !== undefined && target.nativeTurnId !== actor.nativeTurnId) || (target.generation !== undefined && target.generation !== actor.generation)) {
      throw new Error("This native helper is no longer running or cannot be stopped.");
    }
    return { threadId: actor.nativeThreadId, turnId: actor.nativeTurnId };
  }

  request(params: unknown, requestId: string, label: string, outcome?: string): string | undefined {
    const scope = record(params);
    const pendingActor = this.actorFor(params);
    if (pendingActor && !pendingActor.nativeTurnId && string(scope.turnId)) this.receive({ method: "turn/started", params: { threadId: scope.threadId, turn: { id: scope.turnId } } });
    const actor = this.actorFor(params, true);
    if (!actor) return undefined;
    this.activity(actor, `request:${requestId}`, "request", label, outcome ? /^deny|^denied/i.test(outcome) ? "stopped" : "done" : "waiting", { requestId, ...(outcome ? { output: outcome } : {}) });
    return actor.id;
  }

  notice(params: unknown, label: string, detail?: string): void {
    const actor = this.actorFor(params, true);
    if (actor) this.activity(actor, `notice:${++this.sequence}`, "notice", label, "done", { text: text(detail) });
  }

  finish(ok: boolean): void {
    if (this.ended) return;
    this.ended = true;
    for (const [id, owned] of this.threads) {
      if (!terminal(owned.actor.state)) this.put(id, { ...owned.actor, state: owned.actor.kind === "parent" ? ok ? "done" : "failed" : "stopped", endedAt: this.now(), canStop: false });
    }
    for (const activity of this.activities.values()) if (!terminal(activity.state)) this.publish({ ...activity, state: "stopped", endedAt: this.now() });
  }

  receive(value: unknown): void {
    if (this.ended) return;
    const message = record(value);
    const method = string(message.method);
    if (!method) return;
    if (!this.rootThread || !this.rootTurn) {
      if (this.pending.length < 1024) this.pending.push(value);
      return;
    }
    const p = record(message.params);
    if (method === "thread/started") {
      const thread = record(p.thread);
      const source = record(record(record(thread.source).subAgent).thread_spawn);
      const parentId = string(thread.parentThreadId) ?? string(source.parent_thread_id);
      const parent = parentId ? this.threads.get(parentId)?.actor : undefined;
      const id = string(thread.id);
      if (parent && id && id !== this.rootThread) this.child(id, parent, { label: text(thread.agentNickname) ?? text(source.agent_nickname) ?? text(thread.name), model: text(thread.model), task: text(thread.preview) });
      return;
    }
    const threadId = string(p.threadId);
    const owned = threadId ? this.threads.get(threadId) : undefined;
    if (!owned || !threadId) return;
    const turnId = string(method === "turn/started" || method === "turn/completed" ? record(p.turn).id : p.turnId);
    if ((method.startsWith("item/") || method.startsWith("turn/")) && !turnId) return;
    if (threadId === this.rootThread && turnId && turnId !== this.rootTurn) return;
    if (threadId !== this.rootThread && turnId) {
      if (owned.retiredTurns.has(turnId)) return;
      if (owned.actor.nativeTurnId && owned.actor.nativeTurnId !== turnId) {
        if (method !== "turn/started") return;
        if (!terminal(owned.actor.state)) this.emit({ kind: "actor", actor: { ...owned.actor, state: "stopped", endedAt: this.now(), canStop: false } });
        owned.retiredTurns.add(owned.actor.nativeTurnId);
        owned.generation += 1;
        owned.actor = { ...owned.actor, id: `codex:${threadId}:${owned.generation}`, generation: String(owned.generation), nativeTurnId: turnId, state: "running", startedAt: this.now(), endedAt: undefined };
      }
      if (owned.actor.nativeTurnId !== turnId || method === "turn/started") this.put(threadId, { ...owned.actor, nativeTurnId: turnId, ...(method === "turn/started" ? { state: "running" as const, endedAt: undefined } : {}), canStop: !terminal(owned.actor.state) || method === "turn/started" });
    }
    const actor = this.threads.get(threadId)!.actor;
    if (method === "turn/started") return;
    if (method === "turn/completed") {
      if (!turnId) return;
      this.put(threadId, { ...actor, state: stateOf(record(p.turn).status, "done"), endedAt: this.now(), canStop: false, summary: text(record(record(p.turn).error).message) ?? actor.summary });
      if (actor.kind !== "parent") owned.retiredTurns.add(turnId);
      return;
    }
    if (method === "thread/status/changed") {
      const status = record(p.status);
      if (status.type === "active" && !terminal(actor.state)) {
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        this.put(threadId, { ...actor, state: flags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running", canStop: actor.kind !== "parent" && Boolean(actor.nativeTurnId) });
      } else if (status.type === "systemError") this.put(threadId, { ...actor, state: "failed", canStop: false, endedAt: this.now() });
      else if (status.type === "idle" && !terminal(actor.state)) this.put(threadId, { ...actor, state: "waiting", canStop: false });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      if (actor.kind !== "parent") {
        const usage = record(record(p.tokenUsage).last);
        if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") this.put(threadId, { ...actor, usage: { input: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined, output: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined } });
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.item(actor, record(p.item), method === "item/completed");
      return;
    }
    const itemId = string(p.itemId);
    const deltas: Record<string, [NativeActivityKind, string, "text" | "output"]> = {
      "item/agentMessage/delta": ["message", "Message", "text"],
      "item/reasoning/textDelta": ["reasoning", "Reasoning", "text"],
      "item/reasoning/summaryTextDelta": ["reasoning", "Reasoning summary", "text"],
      "item/plan/delta": ["plan", "Plan", "text"],
      "item/commandExecution/outputDelta": ["tool", "Command", "output"],
      "item/fileChange/outputDelta": ["tool", "File changes", "output"],
      "item/mcpToolCall/progress": ["tool", "Tool progress", "output"],
    };
    const delta = deltas[method];
    if (delta && itemId) {
      this.activity(actor, itemId, delta[0], delta[1], "running", { [delta[2]]: text(p.delta ?? p.message) }, delta[2]);
      return;
    }
    if (method === "turn/plan/updated") {
      const steps = Array.isArray(p.plan) ? p.plan.map(value => { const step = record(value); return `${string(step.status) ?? "pending"}: ${text(step.step) ?? ""}`; }).join("\n") : "";
      const done = Array.isArray(p.plan) && p.plan.length > 0 && p.plan.every(value => record(value).status === "completed");
      this.activity(actor, "turn-plan", "plan", "Plan", done ? "done" : "running", { text: [text(p.explanation), steps].filter(Boolean).join("\n") });
      return;
    }
    if (method === "turn/diff/updated") {
      this.activity(actor, "turn-diff", "tool", "Changes", "running", { output: text(p.diff) });
      return;
    }
    if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
      const reviewId = string(p.reviewId);
      const review = record(p.review);
      if (reviewId) this.activity(actor, `review:${reviewId}`, "request", "Automatic approval review", review.status === "denied" || review.status === "timedOut" ? "failed" : method.endsWith("completed") ? "done" : "waiting", { input: printable(p.action), output: text(review.status) });
      return;
    }
    if (method === "item/commandExecution/terminalInteraction" && itemId) {
      this.activity(actor, `${itemId}:stdin:${++this.sequence}`, "tool", "Terminal input", "done", { input: text(p.stdin) });
      return;
    }
    if (method === "hook/started" || method === "hook/completed") {
      const run = record(p.run);
      const id = string(run.id);
      if (id) this.activity(actor, `hook:${id}`, "hook", text(run.statusMessage) ?? text(run.eventName) ?? "Hook", stateOf(run.status, method === "hook/completed" ? "done" : "running"), { output: Array.isArray(run.entries) ? text(run.entries.map(entry => text(record(entry).text)).filter(Boolean).join("\n")) : undefined });
      return;
    }
    if (method === "thread/compacted") {
      this.activity(actor, `compaction:${turnId ?? ++this.sequence}`, "compaction", "Context compacted", "done");
      return;
    }
    if (method === "error" || method === "guardianWarning" || method === "warning") {
      this.activity(actor, `notice:${++this.sequence}`, "notice", method === "error" ? "Codex error" : "Codex notice", method === "error" && !p.willRetry ? "failed" : "done", { text: text(record(p.error).message) ?? text(p.message) });
      return;
    }
    if (["item/", "turn/", "thread/", "hook/", "modelProvider/", "autoApprovalReview/"].some(prefix => method.startsWith(prefix))) this.activity(actor, `notice:${++this.sequence}`, "notice", `Native event: ${method}`, "done");
  }

  private child(id: string, parent: NativeActor, details: Partial<NativeActor> = {}): NativeActor {
    const before = this.threads.get(id)?.actor;
    if (before) {
      this.put(id, { ...before, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) });
      return this.threads.get(id)!.actor;
    }
    const actor: NativeActor = { id: `codex:${id}:0`, parentId: parent.id, nativeId: id, nativeThreadId: id, generation: "0", kind: "subagent", label: "Helper", state: "running", startedAt: this.now(), background: false, canStop: false, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) };
    this.put(id, actor);
    return actor;
  }

  private item(actor: NativeActor, item: RecordValue, completed: boolean): void {
    const type = string(item.type);
    const id = string(item.id);
    if (!type || !id) return;
    if (type === "subAgentActivity") {
      const childId = string(item.agentThreadId);
      if (childId && childId !== this.rootThread) {
        const child = this.child(childId, actor, { label: text(item.agentPath)?.split("/").filter(Boolean).at(-1) });
        if (item.kind === "completed" || item.kind === "interrupted") this.put(childId, { ...child, state: stateOf(item.kind), endedAt: this.now(), canStop: false });
      }
      return;
    }
    if (type === "collabAgentToolCall" || type === "collabToolCall") {
      if (item.senderThreadId && item.senderThreadId !== actor.nativeThreadId) return;
      const states = record(item.agentsStates);
      const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === "string") : [];
      for (const childId of new Set([...ids, ...Object.keys(states)])) {
        if (childId === this.rootThread) continue;
        let child = this.threads.get(childId)?.actor;
        if (!child && item.tool === "spawnAgent") child = this.child(childId, actor, { task: text(item.prompt), model: text(item.model) });
        if (!child) continue;
        const status = record(states[childId]);
        const nextState = stateOf(status.status, child.state);
        const resumed = item.tool === "followupTask" || item.tool === "resumeAgent";
        if (terminal(child.state) && !terminal(nextState) && !resumed) continue;
        this.put(childId, { ...child, state: nextState, summary: text(status.message) ?? child.summary, ...(terminal(nextState) ? { endedAt: this.now(), canStop: false } : {}) });
      }
    }
    const state = item.success === false || (type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed" : stateOf(item.status, completed ? "done" : "running");
    const toolKind = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "functionCallOutput", "collabAgentToolCall", "collabToolCall", "imageView", "imageGeneration", "sleep"].includes(type);
    const kind: NativeActivityKind = toolKind ? "tool" : type === "webSearch" ? "search" : type === "agentMessage" ? "message" : type === "reasoning" ? "reasoning" : type === "plan" ? "plan" : type === "contextCompaction" ? "compaction" : type === "hookPrompt" ? "hook" : "notice";
    if (type === "userMessage") return;
    const action = record(item.action);
    const links = [action, ...(Array.isArray(item.results) ? item.results.map(record) : [])].flatMap(result => {
      const url = string(result.url);
      if (!url || !/^https?:\/\//i.test(url)) return [];
      return [{ title: text(result.title) ?? url, url: url.slice(0, 4000) }];
    }).slice(0, 50);
    const label = type === "commandExecution" ? text(item.command) ?? "Command" : type === "webSearch" ? text(item.query) ?? "Web search" : text(item.tool) ?? ({ agentMessage: "Message", reasoning: "Reasoning", plan: "Plan", contextCompaction: "Context compaction", fileChange: "File changes", hookPrompt: "Hook context" } as Record<string, string>)[type] ?? `Native ${type}`;
    const detail: Partial<NativeActivity> = { input: type === "webSearch" ? printable(item.action) : type === "commandExecution" ? text(item.command) : printable(item.arguments ?? item.prompt),
      output: type === "commandExecution" ? text(item.aggregatedOutput) : type === "webSearch" ? printable(item.results ?? item.action) : type === "imageGeneration" ? printable(item.failure ?? item.savedPath ?? item.revisedPrompt) : printable(item.error ?? item.result ?? item.contentItems ?? item.output ?? item.changes),
      text: text(item.text) ?? text(lines(item.summary) || lines(item.content)) ?? (type === "hookPrompt" && Array.isArray(item.fragments) ? text(item.fragments.map(value => text(record(value).text)).filter(Boolean).join("\n")) : undefined), ...(links.length ? { links } : {}) };
    this.activity(actor, id, kind, label, state, detail);
  }

  private put(id: string, actor: NativeActor): void {
    const owned = this.threads.get(id);
    if (!owned && this.threads.size >= 256) { this.capacityNotice(); return; }
    this.threads.set(id, { actor, retiredTurns: owned?.retiredTurns ?? new Set(), generation: owned?.generation ?? 0 });
    this.emit({ kind: "actor", actor });
  }

  private activity(actor: NativeActor, itemId: string, kind: NativeActivityKind, label: string, state: NativeActorState, detail: Partial<NativeActivity> = {}, append?: "text" | "output"): void {
    const id = itemId.startsWith("request:") ? itemId : `${actor.id}:${itemId}`;
    const before = this.activities.get(id);
    if (!before && this.activities.size >= 4000) { this.capacityNotice(); return; }
    const fields = Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined));
    const next: NativeActivity = { id, actorId: actor.id, kind: before?.kind ?? kind, startedAt: before?.startedAt ?? this.now(), ...before, ...fields, label: append ? before?.label ?? label.slice(0, 240) : label.slice(0, 240), state, ...(terminal(state) ? { endedAt: this.now() } : {}) };
    if ([next.text, next.input, next.output].some(value => value && value.length >= 24_000)) next.truncated = true;
    if (append) {
      const delta = string(detail[append]);
      if (!delta) return;
      const available = Math.max(0, 24_000 - (before?.[append]?.length ?? 0));
      next[append] = `${before?.[append] ?? ""}${delta.slice(0, available)}`;
      next.truncated = before?.truncated || delta.length > available;
    }
    this.publish(next);
  }

  private publish(activity: NativeActivity): void {
    this.activities.set(activity.id, activity);
    this.emit({ kind: "activity", activity });
  }

  private capacityNotice(): void {
    if (this.capacityNoted) return;
    this.capacityNoted = true;
    this.emit({ kind: "activity", activity: { id: "parent:capacity", actorId: "parent", kind: "notice", label: "Native activity limit reached", text: "Additional native activity was omitted from this run's bounded preview.", state: "done", startedAt: this.now(), endedAt: this.now(), truncated: true } });
  }
}
