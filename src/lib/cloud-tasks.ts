import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { t } from "@/lib/i18n";
import { effortName } from "@/lib/model-friendly";
import { api } from "@/state/store";
import type { CloudTaskActivityPage, CloudTaskStep, CloudTaskSummary } from "../../shared/cloud-task";

export type CloudTaskEntry = { summary?: CloudTaskSummary; missing?: boolean; error?: string };

const ACTIVE = new Set(["queued", "preparing", "submitting", "running", "collecting", "publishing", "verifying"]);
const ACTIVE_POLL_MS = 3_000;
const WAITING_POLL_MS = 20_000;

export function cloudTaskActive(summary: CloudTaskSummary | undefined): boolean {
  return Boolean(summary && ACTIVE.has(summary.state));
}

const AGENT_AT_WORK = new Set(["queued", "preparing", "submitting", "running", "collecting"]);

export function cloudTaskWorking(summary: CloudTaskSummary | undefined): boolean {
  return Boolean(summary && AGENT_AT_WORK.has(summary.state));
}

const RETRY_MS = 10_000;

function pollDelay(entry: CloudTaskEntry | undefined): number | null {
  if (!entry) return 0;
  const summary = entry.summary;
  if (!summary) return entry.missing ? null : entry.error ? RETRY_MS : 0;
  if (ACTIVE.has(summary.state)) return ACTIVE_POLL_MS;
  if (summary.state === "ready" && !summary.prUrl && summary.publishable) return WAITING_POLL_MS;
  return null;
}

const entries = new Map<string, CloudTaskEntry>();
const fetchedAt = new Map<string, number>();
const watchers = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let fetching = false;

function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function rememberCloudTasks(summaries: readonly CloudTaskSummary[]): void {
  const now = Date.now();
  let changed = false;
  for (const summary of summaries) {
    const previous = entries.get(summary.id)?.summary;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(summary)) { entries.set(summary.id, { summary }); changed = true; }
    fetchedAt.set(summary.id, now);
  }
  if (changed) emit();
}

async function refresh(force: readonly string[] = []): Promise<void> {
  if (fetching) return;
  const now = Date.now();
  const due = [...watchers.keys()].filter((id) => {
    if (force.includes(id)) return true;
    const delay = pollDelay(entries.get(id));
    return delay !== null && now - (fetchedAt.get(id) ?? 0) >= delay;
  }).slice(0, 100);
  if (!due.length) return;
  fetching = true;
  try {
    const { jobs } = await api<{ jobs: CloudTaskSummary[] }>(`/api/laterdog/jobs?ids=${due.join(",")}`);
    rememberCloudTasks(jobs);
    const found = new Set(jobs.map((job) => job.id));
    let changed = false;
    for (const id of due) {
      if (found.has(id)) continue;
      fetchedAt.set(id, Date.now());
      if (!entries.get(id)?.missing) { entries.set(id, { missing: true }); changed = true; }
    }
    if (changed) emit();
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const id of due) {
      fetchedAt.set(id, Date.now());
      const previous = entries.get(id);
      if (previous?.error !== said) { entries.set(id, { ...previous, error: said }); changed = true; }
    }
    if (changed) emit();
  } finally {
    fetching = false;
  }
}

function schedule(): void {
  if (timer || watchers.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void refresh().finally(schedule);
  }, 1_000);
}

function watch(id: string): void {
  watchers.set(id, (watchers.get(id) ?? 0) + 1);
  if (!entries.has(id)) void refresh([id]);
  schedule();
}

function unwatch(id: string): void {
  const count = (watchers.get(id) ?? 1) - 1;
  if (count > 0) watchers.set(id, count);
  else watchers.delete(id);
}

export function refreshCloudTask(id: string): Promise<void> { return refresh([id]); }

export function useCloudTask(jobId: string | null | undefined): CloudTaskEntry | undefined {
  useEffect(() => {
    if (!jobId) return;
    watch(jobId);
    return () => unwatch(jobId);
  }, [jobId]);
  const read = () => (jobId ? entries.get(jobId) : undefined);
  return useSyncExternalStore(subscribe, read, read);
}

export interface CloudTaskActivity { steps: CloudTaskStep[]; available: boolean; live: boolean; reason?: string; loading: boolean; error?: string }

export function useCloudTaskActivity(jobId: string, active: boolean): CloudTaskActivity {
  const [state, setState] = useState<CloudTaskActivity>({ steps: [], available: false, live: true, loading: true });
  const cursor = useRef(0);
  useEffect(() => { cursor.current = 0; setState({ steps: [], available: false, live: true, loading: true }); }, [jobId]);
  useEffect(() => {
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let delay: number | null = 2_000;
      try {
        const page = await api<CloudTaskActivityPage>(`/api/laterdog/jobs/${jobId}/activity?after=${cursor.current}`);
        if (stopped) return;
        const advanced = page.cursor > cursor.current;
        cursor.current = page.cursor;
        setState((previous) => ({
          steps: page.steps.length ? [...previous.steps, ...page.steps].slice(-2_000) : previous.steps,
          available: page.available || previous.available,
          live: page.live,
          reason: page.reason,
          loading: false,
        }));
        if (advanced && page.steps.length) delay = 300;
        else if (!page.live && !active) delay = null;
        else if (!page.available) delay = 3_000;
      } catch (failure) {
        if (stopped) return;
        setState((previous) => ({ ...previous, loading: false, error: failure instanceof Error ? failure.message : String(failure) }));
        delay = active ? 5_000 : null;
      }
      if (!stopped && delay !== null) next = setTimeout(() => void load(), delay);
    };
    void load();
    return () => { stopped = true; if (next) clearTimeout(next); };
  }, [jobId, active]);
  return state;
}

async function act(jobId: string, body: Record<string, unknown>): Promise<void> {
  try {
    await api(`/api/laterdog/jobs/${jobId}/action`, { method: "POST", body: JSON.stringify(body) });
  } finally {
    await refresh([jobId]);
  }
}
export const stopCloudTask = (jobId: string) => act(jobId, { action: "cancel" });
export const publishCloudTask = (jobId: string) => act(jobId, { action: "publish" });
export const cloudTaskScreen = (jobId: string) => api<{ url: string; expiresAt: number | string }>(`/api/laterdog/jobs/${jobId}/screen`, { method: "POST", body: "{}" });
export const cloudTaskTraceUrl = (jobId: string) => `/api/laterdog/jobs/${jobId}/trace`;

export async function saveCloudTaskTrace(jobId: string): Promise<void> {
  const response = await fetch(cloudTaskTraceUrl(jobId));
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : t("cloudTask.err.trace"));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `laterdog-job-${jobId}-trace.jsonl`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function useTraceSave(jobId: string): { save: () => Promise<void>; saving: boolean; error: string | null } {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try { await saveCloudTaskTrace(jobId); } catch (failure) { setError(failure instanceof Error ? failure.message : t("cloudTask.err.trace")); } finally { setSaving(false); }
  };
  return { save, saving, error };
}
export const cloudTaskPatch = (jobId: string) => api<{ patch: string }>(`/api/laterdog/jobs/${jobId}/patch`);

const WAKEUP_SEND_ID = /^laterdog_([0-9a-f]{32})_\d+$/;
const WAKEUP_TEXT = /^later\.dog job [0-9a-f-]{36}: ([a-z_]+)\./;

export function cloudWakeupOf(message: { role: string; kind?: string; sendId?: string; text?: string }): { jobId: string; event: string } | null {
  if (message.role !== "user" || (message.kind !== undefined && message.kind !== "text") || !message.sendId) return null;
  const hex = WAKEUP_SEND_ID.exec(message.sendId)?.[1];
  if (!hex) return null;
  return {
    jobId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    event: WAKEUP_TEXT.exec(message.text ?? "")?.[1] ?? "updated",
  };
}

export function wakeupLine(event: string): string {
  switch (event) {
    case "collected": return t("cloudTask.update.collected");
    case "published": return t("cloudTask.update.published");
    case "verified": return t("cloudTask.update.verified");
    case "reviewed": return t("cloudTask.update.reviewed");
    case "merged": return t("cloudTask.update.merged");
    case "provider_failed": case "preparation_blocked": case "publication_blocked": case "collection_blocked": case "submission_unknown":
      return t("cloudTask.update.attention");
    default: return t("cloudTask.update.other");
  }
}

export type CloudTaskPhase = "checking" | "unknown" | "waiting" | "working" | "review" | "done" | "stopped" | "attention";

export interface CloudTaskStatusView {
  phase: CloudTaskPhase;
  label: string;
  live: boolean;
  note?: string;
  detail?: string;
  progress: number;
}

const SETTING_UP: Readonly<Record<string, number>> = { starting: 0.16, install: 0.22, clone: 0.28, setup: 0.34 };

function stageProgress(stage: string | undefined): number {
  if (!stage) return 0.12;
  if (Object.hasOwn(SETTING_UP, stage)) return SETTING_UP[stage]!;
  return stage === "done" ? 0.85 : 0.55;
}

function waitingNote(blocker: string | undefined): string | undefined {
  if (!blocker) return undefined;
  if (blocker.startsWith("Waiting for dependency") || blocker.startsWith("Waiting for conflicting writer")) return t("cloudTask.note.otherTask");
  if (blocker.startsWith("All configured execution slots")) return t("cloudTask.note.allBusy");
  return undefined;
}

function bareTool(tool: string): string {
  return tool.replace(/^mcp__.+?__/, "");
}

export function doingNote(step: CloudTaskStep | undefined): string {
  if (!step) return t("cloudTask.doing.working");
  switch (step.k) {
    case "stage": return stageLabel(step.stage);
    case "plan": return t("cloudTask.doing.planning");
    case "done": return stageLabel("done");
    case "tool":
      switch (bareTool(step.tool)) {
        case "Read": case "Grep": case "Glob": case "LS": return t("cloudTask.doing.reading");
        case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return t("cloudTask.doing.changing");
        case "Bash": case "BashOutput": return t("cloudTask.doing.running");
        case "WebFetch": case "WebSearch": return t("cloudTask.doing.lookingUp");
        case "Task": case "Agent": return t("cloudTask.doing.helper");
        default: return t("cloudTask.doing.working");
      }
    default: return t("cloudTask.doing.working");
  }
}

export function cloudTaskStatus(entry: CloudTaskEntry | undefined): CloudTaskStatusView {
  const summary = entry?.summary;
  if (!summary) {
    if (entry?.missing) return { phase: "unknown", label: t("cloudTask.status.missing"), live: false, progress: 0 };
    if (entry?.error) return { phase: "unknown", label: t("cloudTask.status.unreachable"), live: false, detail: entry.error, progress: 0 };
    return { phase: "checking", label: t("cloudTask.status.checking"), live: false, progress: 0 };
  }
  const detail = summary.blocker ? { detail: summary.blocker } : {};
  const working = (note: string, progress: number): CloudTaskStatusView =>
    ({ phase: "working", label: t("cloudTask.status.working"), live: true, note, progress });
  const endedAt = summary.stage ? stageProgress(summary.stage) : 0;
  switch (summary.state) {
    case "queued": {
      const note = waitingNote(summary.blocker);
      return { phase: "waiting", label: t("cloudTask.status.waiting"), live: true, ...(note ? { note } : {}), progress: 0.04, ...detail };
    }
    case "preparing": case "submitting": return working(t("cloudTask.note.starting"), 0.1);
    case "running": {
      const stage = summary.stage;
      const note = !stage || Object.hasOwn(SETTING_UP, stage) ? stageLabel(stage ?? "starting") : stage === "done" ? stageLabel("done") : doingNote(summary.lastStep);
      return working(note, stageProgress(stage));
    }
    case "collecting": return working(t("cloudTask.note.collecting"), 0.9);
    case "publishing": return working(t("cloudTask.note.publishing"), 0.94);
    case "verifying": return working(t("cloudTask.note.verifying"), 0.97);
    case "ready": {
      const files = summary.changes?.files;
      if (summary.kind === "review") return { phase: "done", label: t("cloudTask.status.done"), live: false, progress: 1, ...detail };
      if (!summary.prUrl && files === 0) return { phase: "done", label: t("cloudTask.status.done"), live: false, note: t("cloudTask.note.noChanges"), progress: 1, ...detail };
      return { phase: "review", label: t("cloudTask.status.review"), live: false, ...(files ? { note: filesChangedLabel(files) } : {}), progress: 1, ...detail };
    }
    case "merged": return { phase: "done", label: t("cloudTask.status.done"), live: false, note: t("cloudTask.note.merged"), progress: 1 };
    case "cancelled": return { phase: "stopped", label: t("cloudTask.status.stopped"), live: false, progress: endedAt, ...detail };
    case "needs_attention": case "submission_unknown":
      return { phase: "attention", label: t("cloudTask.status.attention"), live: false, progress: endedAt, ...detail };
    default: return { phase: "unknown", label: summary.state, live: false, progress: 0 };
  }
}

export function cloudTaskStatusClass(view: CloudTaskStatusView): string {
  if (view.live) return "thinking-shimmer animate-shimmer";
  if (view.phase === "attention") return "font-medium text-ink";
  return view.phase === "checking" || view.phase === "unknown" ? "text-ink-tertiary" : "text-ink-secondary";
}

export function stageLabel(stage: string): string {
  switch (stage) {
    case "starting": return t("cloudTask.stage.starting");
    case "install": return t("cloudTask.stage.install");
    case "clone": return t("cloudTask.stage.clone");
    case "setup": return t("cloudTask.stage.setup");
    case "done": return t("cloudTask.stage.done");
    default: return t("cloudTask.doing.working");
  }
}

export interface PlainStep { text: string; detail?: string }

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.replace(/^(?:#{1,6}\s+|[-*>]\s+)/, "").replace(/`/g, "").replace(/\*\*/g, "");
}

export function plainStep(step: CloudTaskStep): PlainStep | null {
  const quiet = (text: string, detail?: string): PlainStep => (detail ? { text, detail } : { text });
  switch (step.k) {
    case "stage": return { text: stageLabel(step.stage) };
    case "say": { const said = firstLine(step.text); return said ? { text: said } : null; }
    case "plan": return { text: t("cloudTask.step.plan") };
    case "error": return quiet(t("cloudTask.step.problem"), step.text);
    case "done": return { text: step.ok ? t("cloudTask.step.done") : t("cloudTask.step.stopped") };
    case "tool":
      switch (bareTool(step.tool)) {
        case "Read": case "LS": return quiet(t("cloudTask.step.read"), step.detail);
        case "Edit": case "MultiEdit": case "NotebookEdit": return quiet(t("cloudTask.step.changed"), step.detail);
        case "Write": return quiet(t("cloudTask.step.wrote"), step.detail);
        case "Grep": return quiet(t("cloudTask.step.searched"), step.detail);
        case "Glob": return quiet(t("cloudTask.step.looked"), step.detail);
        case "Bash": case "BashOutput": return quiet(t("cloudTask.step.ran"), step.detail);
        case "WebFetch": return quiet(t("cloudTask.step.opened"), step.detail);
        case "WebSearch": return quiet(t("cloudTask.step.searchedWeb"), step.detail);
        case "Task": case "Agent": return quiet(t("cloudTask.step.helper"), step.detail);
        default: return quiet(t("cloudTask.step.used"), bareTool(step.tool).replace(/_/g, " "));
      }
  }
}

export function plainSteps(steps: readonly CloudTaskStep[]): PlainStep[] {
  const finalWords = new Set(steps.flatMap((step) => (step.k === "done" && step.text ? [step.text.trim()] : [])));
  const plain: PlainStep[] = [];
  for (const step of steps) {
    if (step.k === "say" && finalWords.has(step.text.trim())) continue;
    const next = plainStep(step);
    if (!next) continue;
    const previous = plain.at(-1);
    if (previous && previous.text === next.text && previous.detail === next.detail) continue;
    plain.push(next);
  }
  return plain.slice(-200);
}

export function projectName(repository: string | undefined): string {
  return repository?.split("/").filter(Boolean).pop() ?? "";
}

export function filesChangedLabel(files: number): string {
  return files === 1 ? t("cloudTask.filesChanged.one") : t("cloudTask.filesChanged", { files });
}

export function elapsedLabel(summary: CloudTaskSummary | undefined, now = Date.now()): string | null {
  if (!summary) return null;
  const from = Date.parse(summary.startedAt ?? summary.createdAt);
  if (!Number.isFinite(from)) return null;
  const to = summary.finishedAt ? Date.parse(summary.finishedAt) : cloudTaskActive(summary) ? now : Date.parse(summary.updatedAt);
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return t("cloudTask.elapsed.underMinute");
  if (minutes < 60) return t("cloudTask.elapsed.minutes", { minutes });
  return t("cloudTask.elapsed.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").split("-").map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))).join(" ").replace(/(\d) (\d)/, "$1.$2");
}

export function runsWithLabel(summary: CloudTaskSummary | undefined): string | null {
  if (!summary) return null;
  const parts = [summary.model ? modelLabel(summary.model) : null, summary.effort ? effortName(summary.effort, "claudeAgent") : null].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

export function traceKeptUntil(summary: CloudTaskSummary | undefined): string | null {
  const expires = summary?.trace ? Date.parse(summary.trace.expiresAt) : NaN;
  return Number.isFinite(expires) ? new Date(expires).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
}
