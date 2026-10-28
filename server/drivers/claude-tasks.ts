import type { Helper, HelperMember, HelperState, HelperStep } from "../../shared/helpers.ts";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const state = (value: unknown): HelperState => value === "completed" || value === "done" ? "done" : value === "failed" || value === "error" ? "failed" : value === "stopped" ? "stopped" : "running";
const RECENT_ACTIVITY_LIMIT = 8;
export const HELPER_STEP_LIMIT = 40;
const STEP_FIELDS = ["description", "command", "file_path", "path", "pattern", "url", "query"] as const;

export function helperStep(name: unknown, input: unknown): HelperStep {
  const given = fields(input);
  const detail = STEP_FIELDS.map(key => text(given[key])).find(Boolean)?.replace(/\s+/g, " ").slice(0, 160);
  return { tool: text(name) ?? "Tool", ...(detail ? { summary: detail } : {}) };
}

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
  if (previous && previous.state !== "running" && patch.status === undefined && event.status === undefined) return previous;
  const status = state(patch.status ?? event.status ?? previous?.state);
  if (previous && previous.state !== "running" && status === "running") return previous;
  const flow = event.task_type === "local_workflow" || previous?.kind === "workflow";
  const workflow = members(event.workflow_progress) ?? previous?.members;
  const progress = event.subtype === "task_progress" ? text(event.description) : undefined;
  const recentActivity = progress && progress !== previous?.activity
    ? [...(previous?.recentActivity ?? []), progress].slice(-RECENT_ACTIVITY_LIMIT)
    : previous?.recentActivity;
  return {
    ...previous, id, kind: flow ? "workflow" : "agent",
    ...(previous?.toolUseId ?? text(event.tool_use_id) ? { toolUseId: previous?.toolUseId ?? text(event.tool_use_id) } : {}),
    label: previous?.label ?? text(event.description) ?? text(event.workflow_name) ?? text(event.subagent_type) ?? "Helper",
    state: status,
    background: typeof event.is_backgrounded === "boolean" ? event.is_backgrounded : previous?.background ?? flow,
    startedAt: previous?.startedAt ?? now,
    ...(status !== "running" ? { endedAt: count(patch.end_time) ?? previous?.endedAt ?? now } : {}),
    ...(progress ? { activity: progress } : {}),
    ...(recentActivity ? { recentActivity } : {}),
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
  private readonly emit: (helper: Helper) => void;
  private readonly now: () => number;
  constructor(emit: (helper: Helper) => void, now: () => number = Date.now) { this.emit = emit; this.now = now; }

  beginTurn(): void { this.helpers.clear(); this.published.clear(); this.consumed.clear(); this.continuations = 0; }

  running(): boolean { return [...this.helpers.values()].some(helper => helper.state === "running"); }
  backgroundRunning(): boolean { return [...this.helpers.values()].some(helper => helper.background && helper.state === "running"); }

  receive(value: unknown): boolean {
    const event = fields(value);
    if (event.subtype === "background_tasks_changed") {
      if (!Array.isArray(event.tasks)) return true;
      const liveIds = new Set(event.tasks.map(task => text(fields(task).task_id)).filter(Boolean));
      for (const helper of this.helpers.values()) {
        if (helper.background && helper.state === "running" && !liveIds.has(helper.id)) {
          this.update({ task_id: helper.id, subtype: "task_updated", patch: { status: "stopped" } });
        }
      }
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

  noteStep(parentToolUseId: unknown, step: HelperStep): boolean {
    const parent = text(parentToolUseId);
    if (!parent) return false;
    const helper = [...this.helpers.values()].find(candidate => candidate.toolUseId === parent);
    if (!helper) return false;
    const next: Helper = { ...helper, steps: [...(helper.steps ?? []), step].slice(-HELPER_STEP_LIMIT) };
    this.helpers.set(helper.id, next);
    this.published.set(helper.id, { at: this.now(), helper: next });
    this.emit(next);
    return true;
  }

  continuationLimitReached(): boolean { return this.continuations >= 3 && [...this.helpers.values()].some(helper => helper.background && helper.state !== "running" && !this.consumed.has(helper.id)); }

  markReported(): void {
    for (const helper of this.helpers.values()) if (helper.background && helper.state !== "running") this.consumed.add(helper.id);
  }

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
