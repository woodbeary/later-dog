import type { Helper, HelperState } from "../../shared/helpers.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const word = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
function helperState(status: unknown): HelperState {
  if (status === "completed") return "done";
  if (status === "errored" || status === "notFound") return "failed";
  if (status === "shutdown" || status === "interrupted") return "stopped";
  return "running";
}

export class CodexHelpers {
  private helpers = new Map<string, Helper>();
  private generations = new Map<string, number>();
  constructor(private emit: (helper: Helper) => void, private now: () => number = Date.now) {}
  receive(value: unknown): void {
    const item = object(value);
    if (item.type === "subAgentActivity") {
      const id = word(item.agentThreadId);
      if (id) this.update(id, helperState(item.kind), word(item.agentPath)?.split("/").filter(Boolean).at(-1), item.kind === "started");
      return;
    }
    if (item.type !== "collabAgentToolCall") return;
    const states = object(item.agentsStates);
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => typeof id === "string") : [];
    for (const id of new Set([...receivers, ...Object.keys(states)])) {
      const status = object(states[id]).status;
      if (status === undefined && item.status !== "completed") continue;
      const fallback = item.tool === "closeAgent" || item.tool === "interruptAgent" ? "interrupted" : "running";
      this.update(id, helperState(status ?? fallback), undefined, item.tool === "followupTask" || item.tool === "resumeAgent");
    }
  }
  private update(nativeId: string, state: HelperState, label?: string, restart = false): void {
    const before = this.helpers.get(nativeId);
    if (before && before.state !== "running" && state === "running" && !restart) return;
    const generation = (this.generations.get(nativeId) ?? 0) + (restart && before && before.state !== "running" ? 1 : 0);
    this.generations.set(nativeId, generation);
    const continuing = before && generation === (Number(before.id.split(":").at(-1)) || 0);
    const startedAt = continuing ? before.startedAt : this.now();
    const next: Helper = { id: `codex:${nativeId}:${generation}`, kind: "agent", label: label ?? before?.label ?? "Helper", state, background: false, startedAt, ...(state !== "running" ? { endedAt: this.now(), durationMs: Math.max(0, this.now() - startedAt) } : {}) };
    if (before && before.id === next.id && before.state === next.state && before.label === next.label) return;
    this.helpers.set(nativeId, next);
    this.emit(next);
  }
  stop(): number {
    let count = 0;
    for (const [id, helper] of this.helpers) if (helper.state === "running") { this.update(id, "stopped"); count += 1; }
    return count;
  }
}
