import type { Helper, HelperMember, HelperState } from "../../shared/helpers.ts";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const state = (value: unknown): HelperState => value === "completed" || value === "done" ? "done" : value === "failed" || value === "error" ? "failed" : value === "stopped" ? "stopped" : "running";

function members(value: unknown): HelperMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(fields).filter(row => row.type === "workflow_agent").slice(0, 64).map((row) => ({
    id: text(row.agentId) ?? String(row.index), label: text(row.label) ?? "Helper", state: state(row.state),
    phase: text(row.phaseTitle), activity: text(row.lastToolSummary) ?? text(row.lastToolName),
    tokens: count(row.tokens), toolUses: count(row.toolCalls), durationMs: count(row.durationMs),
  }));
}

export function mapClaudeTask(previous: Helper | undefined, value: unknown, now = Date.now()): Helper | undefined {
  const event = fields(value);
  const id = text(event.task_id);
  if (!id) return undefined;
  const patch = fields(event.patch);
  const usage = fields(event.usage);
  const status = state(patch.status ?? event.status ?? previous?.state);
  if (previous && previous.state !== "running" && status === "running") return previous;
  const flow = event.task_type === "local_workflow" || previous?.kind === "workflow";
  const workflow = members(event.workflow_progress) ?? previous?.members;
  return {
    ...previous, id, kind: flow ? "workflow" : "agent",
    label: previous?.label ?? text(event.description) ?? text(event.workflow_name) ?? text(event.subagent_type) ?? "Helper",
    state: status,
    background: typeof event.is_backgrounded === "boolean" ? event.is_backgrounded : previous?.background ?? flow,
    startedAt: previous?.startedAt ?? now,
    ...(status !== "running" ? { endedAt: count(patch.end_time) ?? previous?.endedAt ?? now } : {}),
    ...(event.subtype === "task_progress" && text(event.description) ? { activity: text(event.description) } : {}),
    ...(text(event.summary) ? { summary: text(event.summary) } : {}),
    ...(count(usage.total_tokens) !== undefined ? { tokens: count(usage.total_tokens) } : {}),
    ...(count(usage.tool_uses) !== undefined ? { toolUses: count(usage.tool_uses) } : {}),
    ...(count(usage.duration_ms) !== undefined ? { durationMs: count(usage.duration_ms) } : {}),
    ...(workflow ? { members: workflow.map(member => status !== "running" && member.state === "running" ? { ...member, state: status } : member) } : {}),
  };
}

export class ClaudeTasks {
  private helpers = new Map<string, Helper>();
  private published = new Map<string, { at: number; helper: Helper }>();
  private consumed = new Set<string>();
  private continuations = 0;
  constructor(private emit: (helper: Helper) => void, private now: () => number = Date.now) {}

  beginTurn(): void { this.helpers.clear(); this.published.clear(); this.consumed.clear(); this.continuations = 0; }

  running(): boolean { return [...this.helpers.values()].some(helper => helper.state === "running"); }
  backgroundRunning(): boolean { return [...this.helpers.values()].some(helper => helper.background && helper.state === "running"); }

  receive(value: unknown): boolean {
    const event = fields(value);
    if (event.subtype === "background_tasks_changed") {
      if (!Array.isArray(event.tasks)) return true;
      for (const task of event.tasks) this.update({ ...fields(task), is_backgrounded: true });
      return true;
    }
    if (!["task_started", "task_progress", "task_updated", "task_notification"].includes(String(event.subtype))) return false;
    this.update(event);
    return true;
  }

  private update(event: Fields): void {
    const id = text(event.task_id);
    if (!id) return;
    const previous = this.helpers.get(id);
    const next = mapClaudeTask(previous, event, this.now());
    if (!next || next === previous) return;
    this.helpers.set(id, next);
    const last = this.published.get(id);
    const memberState = (helper: Helper) => helper.members?.map(member => `${member.id}:${member.state}:${member.phase}`).join("|");
    if (last && next.state === "running" && next.state === last.helper.state && memberState(next) === memberState(last.helper) && this.now() - last.at < 750) return;
    this.published.set(id, { at: this.now(), helper: next });
    this.emit(next);
  }

  continuationLimitReached(): boolean { return this.continuations >= 3 && [...this.helpers.values()].some(helper => helper.background && helper.state !== "running" && !this.consumed.has(helper.id)); }

  takeContinuation(): boolean {
    if (this.backgroundRunning() || this.continuations >= 3) return false;
    const done = [...this.helpers.values()].filter(helper => helper.background && helper.state !== "running" && !this.consumed.has(helper.id));
    if (!done.length) return false;
    for (const helper of done) this.consumed.add(helper.id);
    this.continuations += 1;
    return true;
  }

  stop(): number {
    let stopped = 0;
    for (const helper of this.helpers.values()) {
      if (helper.state !== "running") continue;
      const next: Helper = { ...helper, state: "stopped", endedAt: this.now(), members: helper.members?.map(member => member.state === "running" ? { ...member, state: "stopped" } : member) };
      this.helpers.set(helper.id, next);
      this.emit(next);
      stopped += 1;
    }
    return stopped;
  }
}
