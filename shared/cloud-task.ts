import type { BackendId, Job, JobComputerSize, JobEffort, JobState } from "./laterdog.ts";

export interface CloudTaskRef { jobId: string; title: string; repository?: string; backend?: string }

export interface CloudTaskTodo { text: string; status: "pending" | "in_progress" | "completed" }

export type CloudTaskStep =
  | { t: number; k: "stage"; stage: string }
  | { t: number; k: "say"; text: string }
  | { t: number; k: "tool"; tool: string; detail?: string }
  | { t: number; k: "plan"; todos: CloudTaskTodo[] }
  | { t: number; k: "error"; text: string }
  | { t: number; k: "done"; ok: boolean; text?: string; turns?: number; ms?: number };

export interface CloudTaskChanges { files: number; additions: number; deletions: number }

export interface CloudTaskSummary {
  id: string;
  title: string;
  state: JobState;
  backend: BackendId;
  repository: string;
  kind: Job["kind"];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputBranch: string;
  prUrl?: string;
  prNumber?: number;
  blocker?: string;
  changes?: CloudTaskChanges;
  stage?: string;
  lastStep?: CloudTaskStep;
  botId?: string;
  conversationId?: string;
  screen: boolean;
  stoppable: boolean;
  publishable: boolean;
  model?: string;
  effort?: JobEffort;
  account?: string;
  computerSize?: JobComputerSize;
  trace?: { bytes: number; expiresAt: string; truncated: boolean };
}

export interface CloudTaskActivityPage { steps: CloudTaskStep[]; cursor: number; live: boolean; available: boolean; reason?: string }

export const CLOUD_TASK_STAGES = ["starting", "install", "clone", "setup", "claude", "done"] as const;
export const MAX_STEP_TEXT = 4000;
export const MAX_STEP_DETAIL = 300;
export const MAX_ACTIVITY_PAGE_BYTES = 256 * 1024;

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

export function cloudTaskStep(value: unknown): CloudTaskStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const t = typeof record.t === "number" && Number.isFinite(record.t) ? record.t : 0;
  switch (record.k) {
    case "stage": {
      const stage = typeof record.stage === "string" && /^[a-z]{1,20}$/.test(record.stage) ? record.stage : undefined;
      return stage ? { t, k: "stage", stage } : null;
    }
    case "say": {
      const said = text(record.text, MAX_STEP_TEXT);
      return said ? { t, k: "say", text: said } : null;
    }
    case "tool": {
      const tool = text(record.tool, 80);
      if (!tool) return null;
      const detail = text(record.detail, MAX_STEP_DETAIL);
      return { t, k: "tool", tool, ...(detail ? { detail } : {}) };
    }
    case "plan": {
      if (!Array.isArray(record.todos)) return null;
      const todos = record.todos.slice(0, 50).flatMap((todo): CloudTaskTodo[] => {
        if (!todo || typeof todo !== "object") return [];
        const entry = todo as Record<string, unknown>;
        const label = text(entry.text, 300);
        const status = typeof entry.status === "string" && TODO_STATUSES.has(entry.status) ? entry.status as CloudTaskTodo["status"] : "pending";
        return label ? [{ text: label, status }] : [];
      });
      return todos.length ? { t, k: "plan", todos } : null;
    }
    case "error": {
      const said = text(record.text, MAX_STEP_DETAIL);
      return said ? { t, k: "error", text: said } : null;
    }
    case "done": {
      const said = text(record.text, MAX_STEP_TEXT);
      return {
        t, k: "done", ok: record.ok !== false,
        ...(said ? { text: said } : {}),
        ...(typeof record.turns === "number" && Number.isFinite(record.turns) ? { turns: record.turns } : {}),
        ...(typeof record.ms === "number" && Number.isFinite(record.ms) ? { ms: record.ms } : {}),
      };
    }
    default:
      return null;
  }
}

export function parseCloudTaskSteps(chunk: string): { steps: CloudTaskStep[]; consumedBytes: number } {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { steps: [], consumedBytes: 0 };
  const complete = chunk.slice(0, end + 1);
  const steps: CloudTaskStep[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const step = cloudTaskStep(parsed);
    if (step) steps.push(step);
  }
  return { steps, consumedBytes: new TextEncoder().encode(complete).length };
}

export function lastMeaningfulStep(steps: readonly CloudTaskStep[]): CloudTaskStep | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.k !== "plan") return step;
  }
  return undefined;
}

export function patchChanges(patch: string): CloudTaskChanges {
  let files = 0; let additions = 0; let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files, additions, deletions };
}

const HEADER_PREFIXES = ["+++", "---", "index ", "new file mode ", "deleted file mode ", "old mode ", "new mode ", "similarity index ", "rename from ", "rename to "];

export interface CloudTaskFileChange { path: string; additions: number; deletions: number; binary: boolean; hunks: string }

export function patchFiles(patch: string): CloudTaskFileChange[] {
  const files: CloudTaskFileChange[] = [];
  let current: CloudTaskFileChange | null = null;
  let body: string[] = [];
  const close = () => { if (current) { current.hunks = body.join("\n"); files.push(current); } current = null; body = []; };
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) { close(); current = { path: header[2], additions: 0, deletions: 0, binary: false, hunks: "" }; continue; }
    if (!current) continue;
    const file: CloudTaskFileChange = current;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { file.binary = true; continue; }
    if (HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    if (line.startsWith("@@") || line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
      if (line.startsWith("+")) file.additions += 1;
      else if (line.startsWith("-")) file.deletions += 1;
      if (!file.binary) body.push(line);
    }
  }
  close();
  return files;
}

export function cloudTaskSummary(job: Job, accountLabel?: string, now = Date.now()): CloudTaskSummary {
  const running = job.state === "running" && Boolean(job.taskId);
  return {
    id: job.id, title: job.title, state: job.state, backend: job.backend, repository: job.repository, kind: job.kind,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    outputBranch: job.outputBranch,
    ...(job.prUrl ? { prUrl: job.prUrl } : {}),
    ...(job.prNumber ? { prNumber: job.prNumber } : {}),
    ...(job.blocker ? { blocker: job.blocker } : {}),
    ...(job.changes ? { changes: job.changes } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.lastStep ? { lastStep: job.lastStep } : {}),
    ...(job.botId ? { botId: job.botId } : {}),
    ...(job.conversationId ? { conversationId: job.conversationId } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.effort ? { effort: job.effort } : {}),
    ...(accountLabel ? { account: accountLabel } : {}),
    ...(job.computerSize ? { computerSize: job.computerSize } : {}),
    ...(job.trace && Date.parse(job.trace.expiresAt) > now ? { trace: { bytes: job.trace.bytes, expiresAt: job.trace.expiresAt, truncated: job.trace.truncated } } : {}),
    screen: running && job.backend === "laterdog-cloud",
    stoppable: ["queued", "preparing"].includes(job.state) || (running && job.backend === "laterdog-cloud" && !job.cancelRequested),
    publishable: job.kind !== "review" && !job.prUrl && !job.cancelRequested && ["ready", "needs_attention"].includes(job.state) && Boolean(job.patchArtifact) && (job.changes ? job.changes.files > 0 : true),
  };
}
