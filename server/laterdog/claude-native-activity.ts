import { createHash } from "node:crypto";
import type { NativeActivity, NativeActor, NativeActorState, NativeObservation } from "../../shared/native-runs.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolDetailPreview } from "../tool-summary.ts";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const text = (value: unknown, limit = 24_000): string | undefined => typeof value === "string" ? redactSecretsInText(value).slice(0, limit) : undefined;
const id = (...parts: Array<string | undefined>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const terminal = (state: NativeActorState) => state === "done" || state === "failed" || state === "stopped";

export function claudeTaskState(value: unknown): NativeActorState | undefined {
  if (value === "completed" || value === "done") return "done";
  if (value === "failed" || value === "error") return "failed";
  if (value === "stopped" || value === "killed") return "stopped";
  if (value === "paused") return "paused";
  if (value === "pending" || value === "waiting") return "waiting";
  if (value === "running") return "running";
  return undefined;
}

export function claudeChildMessage(value: unknown): boolean {
  const event = fields(value);
  return Boolean(string(event.parent_tool_use_id) || string(event.agent_id));
}

export function claudeSearchLinks(value: unknown): NonNullable<NativeActivity["links"]> {
  const links = new Map<string, { title: string; url: string }>();
  let budget = 150;
  const visit = (item: unknown, depth = 0): void => {
    if (--budget < 0 || depth > 6 || links.size >= 30) return;
    if (typeof item === "string") {
      if (item.length < 100_000 && /^\s*[[{]/.test(item)) {
        try { visit(JSON.parse(item), depth + 1); } catch {}
      }
      return;
    }
    if (Array.isArray(item)) { for (const child of item.slice(0, 40)) visit(child, depth + 1); return; }
    const row = fields(item);
    const url = string(row.url);
    if (url && url.length <= 2_000) {
      try {
        const parsed = new URL(url);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && redactSecretsInText(url) === url) {
          links.set(url, { title: text(row.title, 240) || parsed.hostname, url });
        }
      } catch {}
    }
    for (const key of ["results", "content", "citations", "sources", "links", "tool_use_result", "text"]) if (row[key] !== undefined) visit(row[key], depth + 1);
  };
  visit(value);
  return [...links.values()];
}

interface ToolRecord { actorId: string; activity: NativeActivity; }
interface StreamRecord { activity: NativeActivity; messageId: string; index: number; blockType: string; reconciled?: boolean; raw: string; }

export class ClaudeNativeActivity {
  private readonly emit: (observation: NativeObservation) => void;
  private readonly now: () => number;
  private readonly version?: string;
  private sessionId?: string;
  private actors = new Map<string, NativeActor>();
  private latestTasks = new Map<string, NativeActor>();
  private taskParents = new Map<string, string>();
  private invocations = new Map<string, string>();
  private tools = new Map<string, ToolRecord>();
  private seen = new Set<string>();
  private published = new Set<string>();
  private streams = new Map<string, StreamRecord>();
  private streamMessage?: string;
  private sequence = 0;
  private liveBackground = new Set<string>();
  private limitations = new Set<string>();
  private pendingRetry?: NativeActivity;
  private pendingThinking?: NativeActivity;

  constructor(emit: (observation: NativeObservation) => void, options: { version?: string; sessionId?: string; now?: () => number } = {}) {
    this.emit = emit;
    this.now = options.now ?? Date.now;
    this.version = options.version;
    this.sessionId = options.sessionId;
  }

  beginTurn(): void {
    this.published.clear();
    this.streams.clear();
    this.streamMessage = undefined;
    this.pendingThinking = undefined;
    this.pendingRetry = undefined;
    this.limit("Native background work stays inside the owning turn; individual native tasks cannot be stopped separately.");
    if (!this.version) this.limit("Claude Code version was not reported; child text forwarding is unavailable.");
    else {
      const patch = this.version.split(".").map(Number);
      if (patch[0]! < 2 || patch[0] === 2 && (patch[1]! < 1 || patch[1] === 1 && patch[2]! < 211)) this.limit("This Claude Code version cannot forward child text and thinking.");
      if (patch[0] === 2 && patch[1] === 1 && patch[2]! < 292) this.limit("This Claude Code version may omit native task generations and child identity.");
    }
    this.emit({ kind: "capabilities", version: this.version, handlesParentActivity: true, limitations: [...this.limitations] });
  }

  actorForTool(toolUseId: unknown): string | undefined {
    return typeof toolUseId === "string" ? this.tools.get(toolUseId)?.actorId : undefined;
  }

  actorForRequest(value: { toolUseId?: string; agentId?: string }): string | undefined {
    return this.actorForTool(value.toolUseId) ?? (value.agentId ? this.latestTasks.get(value.agentId)?.id : undefined);
  }

  private limit(message: string): void {
    if (this.limitations.has(message)) return;
    this.limitations.add(message);
    this.emit({ kind: "capabilities", version: this.version, handlesParentActivity: true, limitations: [...this.limitations] });
  }

  private actor(actor: NativeActor): NativeActor {
    if (this.actors.size >= 512 && !this.actors.has(actor.id)) {
      const stale = [...this.actors.values()].find(row => terminal(row.state));
      this.actors.delete(stale?.id ?? this.actors.keys().next().value!);
      this.limit("Native actor correlation reached its session limit; older attribution may be unavailable.");
    }
    this.actors.set(actor.id, actor);
    this.published.add(actor.id);
    this.emit({ kind: "actor", actor });
    return actor;
  }

  private publishActor(actorId: string): void {
    const actor = this.actors.get(actorId);
    if (actor && !this.published.has(actorId)) this.actor(actor);
  }

  private scope(event: Fields): string {
    const parentTool = string(event.parent_tool_use_id);
    const agentId = string(event.agent_id);
    const correlated = parentTool ? this.invocations.get(parentTool) : undefined;
    if (correlated) { this.publishActor(correlated); return correlated; }
    if (!parentTool && !agentId) return "parent";
    const actorId = `claude-unattributed-${id(this.sessionId, agentId, parentTool)}`;
    if (!this.actors.has(actorId)) {
      this.actor({ id: actorId, kind: "subagent", label: text(event.task_description, 160) || text(event.subagent_type, 160) || "Native subagent", state: "running", nativeId: agentId, nativeThreadId: this.sessionId, generation: parentTool ? `invocation:${parentTool}` : undefined, startedAt: this.now(), activity: "Native run attribution unavailable", canStop: false });
      this.limit("Some child messages have no task/run correlation; they are shown separately with uncertain attribution.");
    } else this.publishActor(actorId);
    return actorId;
  }

  private task(event: Fields): void {
    const taskId = string(event.task_id);
    if (!taskId) return;
    const runId = string(event.run_id);
    const previous = this.latestTasks.get(taskId);
    if (runId && previous?.generation && !previous.generation.startsWith("invocation:") && runId < previous.generation) return;
    const invocation = string(event.tool_use_id);
    const generation = runId ?? (invocation ? `invocation:${invocation}` : previous?.generation);
    const actorId = `claude-task-${id(this.sessionId, taskId, generation)}`;
    const old = this.actors.get(actorId);
    const patch = fields(event.patch);
    const nextState = claudeTaskState(patch.status ?? event.status) ?? old?.state ?? "running";
    const state = old && terminal(old.state) && !terminal(nextState) ? old.state : nextState;
    const taskType = string(event.task_type);
    const kind = taskType === "local_agent" ? "subagent" : taskType === "local_workflow" ? "workflow" : old?.kind ?? "task";
    const parentTask = string(event.parent_task_id);
    if (parentTask) this.taskParents.set(taskId, parentTask);
    const parentId = parentTask ? this.latestTasks.get(parentTask)?.id : old?.parentId ?? this.tools.get(invocation ?? "")?.actorId ?? (event.spawn_depth === 1 ? "parent" : undefined);
    const actor = this.actor({
      ...old, id: actorId, parentId, kind, nativeId: taskId, nativeThreadId: this.sessionId, generation,
      label: old?.label || text(event.description, 160) || text(event.subagent_type, 160) || (kind === "subagent" ? "Native subagent" : "Native task"),
      task: text(event.prompt, 2_000) || old?.task || text(event.description, 2_000), state, startedAt: old?.startedAt ?? this.now(),
      ...(terminal(state) ? { endedAt: count(patch.end_time) ?? old?.endedAt ?? this.now() } : {}),
      background: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : typeof event.is_backgrounded === "boolean" ? event.is_backgrounded : old?.background,
      ambient: typeof event.ambient === "boolean" ? event.ambient : old?.ambient,
      canStop: false,
      activity: event.ambient === true ? "Background watcher" : parentTask && !parentId ? "Parent task attribution unavailable" : text(event.summary, 500) || (event.subtype === "task_progress" ? text(event.description, 500) : old?.activity) || (!generation ? "Native run generation not reported" : undefined),
      summary: text(event.summary, 2_000) ?? old?.summary,
    });
    this.latestTasks.set(taskId, actor);
    if (invocation) this.invocations.set(invocation, actorId);
    if (this.latestTasks.size > 512) this.latestTasks.delete(this.latestTasks.keys().next().value!);
    if (this.taskParents.size > 512) this.taskParents.delete(this.taskParents.keys().next().value!);
    if (this.invocations.size > 2_048) this.invocations.delete(this.invocations.keys().next().value!);
    for (const [childId, nativeParent] of this.taskParents) {
      const child = this.latestTasks.get(childId);
      if (nativeParent === taskId && child && !child.parentId) {
        const updated = this.actor({ ...child, parentId: actorId, activity: child.activity === "Parent task attribution unavailable" ? undefined : child.activity });
        this.latestTasks.set(childId, updated);
      }
    }
    if (Array.isArray(event.workflow_progress)) for (const value of event.workflow_progress.slice(0, 64)) {
      const member = fields(value);
      if (member.type !== "workflow_agent") continue;
      const memberId = string(member.agentId) ?? String(member.index);
      const memberActorId = `claude-workflow-agent-${id(actorId, memberId)}`;
      const earlier = this.actors.get(memberActorId);
      const memberState = claudeTaskState(member.state) ?? "running";
      const knownState = earlier && terminal(earlier.state) && !terminal(memberState) ? earlier.state : memberState;
      this.actor({ ...earlier, id: memberActorId, parentId: actorId, kind: "subagent", label: text(member.label, 160) || earlier?.label || "Workflow agent", state: knownState, nativeId: memberId, nativeThreadId: this.sessionId, generation, task: text(member.phaseTitle, 500) ?? earlier?.task, activity: text(member.lastToolSummary ?? member.lastToolName, 500), startedAt: earlier?.startedAt ?? this.now(), ...(terminal(knownState) ? { endedAt: earlier?.endedAt ?? this.now() } : {}), canStop: false });
    }
    const usage = fields(event.usage);
    if (count(usage.total_tokens) !== undefined) this.activity({ id: `claude-usage-${id(actorId)}`, actorId, kind: "notice", label: "Reported task usage", state: "done", startedAt: actor.startedAt, endedAt: this.now(), output: `${usage.total_tokens} total tokens${count(usage.tool_uses) !== undefined ? ` · ${usage.tool_uses} tool uses` : ""}${count(usage.duration_ms) !== undefined ? ` · ${usage.duration_ms} ms` : ""}` });
  }

  private activity(activity: NativeActivity): void {
    this.publishActor(activity.actorId);
    this.emit({ kind: "activity", activity });
  }

  private notice(event: Fields, label: string, output?: unknown, state: NativeActorState = "done", kind: NativeActivity["kind"] = "notice"): NativeActivity {
    const key = string(event.hook_id) ?? string(event.uuid) ?? `${++this.sequence}`;
    const activity: NativeActivity = { id: `claude-${kind}-${id(key)}`, actorId: this.scope(event), kind, label, state, startedAt: this.now(), ...(terminal(state) ? { endedAt: this.now() } : {}), output: toolDetailPreview(output) };
    this.activity(activity);
    return activity;
  }

  private stream(event: Fields): void {
    if (claudeChildMessage(event)) return;
    const frame = fields(event.event);
    if (frame.type === "message_start") { this.streamMessage = string(fields(frame.message).id) ?? `stream-${++this.sequence}`; return; }
    const index = count(frame.index) ?? 0;
    const messageId = this.streamMessage ?? (this.streamMessage = `stream-${++this.sequence}`);
    const key = `${messageId}:${index}`;
    if (frame.type === "content_block_start") {
      const block = fields(frame.content_block);
      if (block.type !== "text" && block.type !== "thinking") return;
      this.streams.set(key, { messageId, index, blockType: block.type, raw: "", activity: { id: `claude-block-${id(this.sessionId, messageId, String(index))}`, actorId: "parent", kind: block.type === "thinking" ? "reasoning" : "message", label: block.type === "thinking" ? "Thinking" : "Message", state: "running", startedAt: this.now(), text: "" } });
    } else if (frame.type === "content_block_delta") {
      const delta = fields(frame.delta);
      const raw = delta.type === "thinking_delta" ? string(delta.thinking) : delta.type === "text_delta" ? string(delta.text) : undefined;
      if (!raw) return;
      const blockType = delta.type === "thinking_delta" ? "thinking" : "text";
      const row = this.streams.get(key) ?? { messageId, index, blockType, raw: "", activity: { id: `claude-block-${id(this.sessionId, messageId, String(index))}`, actorId: "parent", kind: blockType === "thinking" ? "reasoning" as const : "message" as const, label: blockType === "thinking" ? "Thinking" : "Message", state: "running" as const, startedAt: this.now() } };
      const joined = row.raw + raw;
      row.raw = joined.slice(0, 24_000);
      row.activity = { ...row.activity, text: text(row.raw), truncated: row.activity.truncated || joined.length > 24_000 };
      this.streams.set(key, row);
      if (this.streams.size > 512) this.streams.delete(this.streams.keys().next().value!);
      this.activity(row.activity);
    } else if (frame.type === "content_block_stop") {
      const row = this.streams.get(key);
      if (row) { row.activity = { ...row.activity, state: "done", endedAt: this.now() }; this.activity(row.activity); }
    }
  }

  private message(event: Fields): void {
    if (event.isReplay === true) return;
    const message = fields(event.message);
    const actorId = this.scope(event);
    const messageId = string(message.id);
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const [index, value] of blocks.entries()) {
      const block = fields(value);
      const blockId = string(event.uuid) ?? `${messageId ?? ++this.sequence}`;
      if (block.type === "tool_use") {
        const toolId = string(block.id);
        if (!toolId) continue;
        const tool = string(block.name) ?? "Tool";
        const input = fields(block.input);
        const search = tool === "WebSearch" || tool === "WebFetch";
        const activity: NativeActivity = { id: `claude-tool-${id(this.sessionId, toolId)}`, actorId, kind: search ? "search" : "tool", label: search ? `${tool}: ${text(input.query ?? input.url, 300) ?? ""}`.trim() : tool, state: "running", startedAt: this.now(), input: toolDetailPreview(block.input), ...(search ? { links: claudeSearchLinks(block.input) } : {}) };
        this.tools.set(toolId, { actorId, activity });
        if (this.tools.size > 2_048) this.tools.delete(this.tools.keys().next().value!);
        this.activity(activity);
      } else if (block.type === "tool_result") {
        const toolId = string(block.tool_use_id);
        if (!toolId) continue;
        const previous = this.tools.get(toolId);
        const links = claudeSearchLinks(event.tool_use_result ?? block.content);
        const activity: NativeActivity = { ...previous?.activity, id: previous?.activity.id ?? `claude-tool-${id(this.sessionId, toolId)}`, actorId: previous?.actorId ?? actorId, kind: previous?.activity.kind ?? "tool", label: previous?.activity.label ?? "Tool result", state: block.is_error === true ? "failed" : "done", startedAt: previous?.activity.startedAt ?? this.now(), endedAt: this.now(), output: toolDetailPreview(event.tool_use_result ?? block.content), ...(links.length ? { links } : {}) };
        this.tools.set(toolId, { actorId: activity.actorId, activity });
        this.activity(activity);
      } else if (event.type === "assistant" && (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking")) {
        const raw = string(block.text ?? block.thinking) ?? "";
        const streamed = actorId === "parent" ? [...this.streams.values()].find(row => !row.reconciled && row.blockType === block.type && (!messageId || row.messageId === messageId)) : undefined;
        if (streamed) streamed.reconciled = true;
        const reasoning = block.type !== "text";
        this.activity({ id: streamed?.activity.id ?? `claude-message-${id(this.sessionId, actorId, blockId, String(index))}`, actorId, kind: reasoning ? "reasoning" : "message", label: block.type === "redacted_thinking" ? "Thinking unavailable" : reasoning ? "Thinking" : "Message", state: event.aborted === true ? "stopped" : "done", startedAt: streamed?.activity.startedAt ?? this.now(), endedAt: this.now(), text: block.type === "redacted_thinking" ? "Claude did not expose this thinking content." : text(raw), truncated: raw.length > 24_000 || undefined });
      } else if (event.type === "user" && actorId !== "parent" && block.type === "text") {
        this.activity({ id: `claude-prompt-${id(this.sessionId, actorId, blockId, String(index))}`, actorId, kind: "message", label: "Subagent instructions", state: "done", startedAt: this.now(), endedAt: this.now(), text: text(block.text), truncated: typeof block.text === "string" && block.text.length > 24_000 || undefined });
      }
    }
  }

  receive(value: unknown): void {
    const event = fields(value);
    const uuid = string(event.uuid);
    if (uuid && this.seen.has(uuid)) return;
    if (uuid) { this.seen.add(uuid); if (this.seen.size > 8_192) this.seen.delete(this.seen.values().next().value!); }
    this.sessionId = string(event.session_id) ?? this.sessionId;
    if (this.pendingThinking && !claudeChildMessage(event) && (event.type === "assistant" || event.type === "result")) {
      this.activity({ ...this.pendingThinking, state: "done", endedAt: this.now() });
      this.pendingThinking = undefined;
    }
    if (this.pendingRetry && !claudeChildMessage(event) && (event.type === "assistant" || event.type === "result" || event.type === "stream_event" && fields(event.event).type === "message_start" || event.subtype === "api_retry")) {
      this.activity({ ...this.pendingRetry, state: event.type === "result" && event.is_error === true ? "failed" : "done", endedAt: this.now() });
      this.pendingRetry = undefined;
    }
    if (event.type === "assistant" || event.type === "user") { this.message(event); return; }
    if (event.type === "stream_event") { this.stream(event); return; }
    if (event.type === "tool_progress") {
      const tool = this.tools.get(String(event.tool_use_id));
      if (tool && !terminal(tool.activity.state)) this.activity({ ...tool.activity, output: `${count(event.elapsed_time_seconds) ?? 0}s elapsed` });
      return;
    }
    if (event.type !== "system") return;
    const subtype = String(event.subtype);
    if (["task_started", "task_progress", "task_updated", "task_notification"].includes(subtype)) { this.task(event); return; }
    if (subtype === "background_tasks_changed") {
      if (!Array.isArray(event.tasks)) return;
      const next = new Set<string>();
      for (const value of event.tasks) {
        const row = fields(value);
        this.task({ ...row, is_backgrounded: true });
        const actor = this.latestTasks.get(String(row.task_id));
        if (actor) next.add(actor.id);
      }
      for (const actorId of this.liveBackground) {
        const actor = this.actors.get(actorId);
        if (!next.has(actorId) && actor && !terminal(actor.state)) this.actor({ ...actor, state: "waiting", activity: "No longer in the native background list; outcome not reported" });
      }
      this.liveBackground = next;
      return;
    }
    if (subtype === "init") {
      this.actor({ id: "parent", kind: "parent", label: "Claude", state: "running", nativeThreadId: this.sessionId, model: text(event.model, 160), startedAt: this.now() });
      for (const key of ["plugin_errors", "mcp_server_errors"]) for (const value of Array.isArray(event[key]) ? event[key] as unknown[] : []) {
        const error = fields(value);
        this.notice({ ...event, uuid: `${uuid ?? "init"}:${key}:${id(JSON.stringify(error))}` }, `${key === "plugin_errors" ? "Plugin" : "MCP server"} failed to load: ${text(error.plugin ?? error.name, 120) ?? "unknown"}`, error.message ?? error, "failed");
      }
      for (const value of Array.isArray(event.mcp_servers) ? event.mcp_servers : []) {
        const server = fields(value);
        if (server.status === "failed" || server.status === "needs-auth") this.notice({ ...event, uuid: `${uuid ?? "init"}:mcp:${string(server.name)}` }, `MCP server ${text(server.name, 120) ?? "unknown"}: ${server.status}`, undefined, "failed");
      }
    } else if (subtype === "thinking_tokens" && count(event.estimated_tokens) !== undefined) {
      this.pendingThinking = { id: this.pendingThinking?.id ?? `claude-thinking-estimate-${id(string(event.user_message_uuid), String(++this.sequence))}`, actorId: "parent", kind: "reasoning", label: "Thinking", state: "running", startedAt: this.pendingThinking?.startedAt ?? this.now(), text: `${event.estimated_tokens} estimated thinking tokens` };
      this.activity(this.pendingThinking);
    } else if (subtype === "api_retry") this.pendingRetry = this.notice(event, `Claude retry ${count(event.attempt) ?? ""}`.trim(), { error: event.error, retry_delay_ms: event.retry_delay_ms }, "waiting");
    else if (subtype === "permission_denied") this.notice(event, "Native permission denied", event, "failed", "request");
    else if (subtype === "hook_started" || subtype === "hook_progress" || subtype === "hook_response") this.notice(event, text(event.hook_name ?? event.hook_event, 160) || "Claude hook", event.output ?? event.stdout ?? event.stderr, subtype === "hook_response" ? event.exit_code && event.exit_code !== 0 ? "failed" : "done" : "running", "hook");
    else if (subtype === "compact_boundary") this.notice(event, "Context compacted", event.compact_metadata, "done", "compaction");
    else if (subtype === "plugin_install") this.notice(event, `Plugin ${text(event.name, 160) ?? "installation"}`, event.error ?? event.status, event.status === "failed" ? "failed" : event.status === "started" ? "running" : "done");
    else if (subtype === "warning") this.notice(event, "Claude warning", event.message ?? event, "waiting");
  }
}
