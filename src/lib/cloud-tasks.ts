import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { t } from "@/lib/i18n";
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

function pollDelay(entry: CloudTaskEntry | undefined): number | null {
  if (!entry || (!entry.summary && !entry.missing)) return 0;
  const summary = entry.summary;
  if (!summary) return null;
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

export function useBotCloudTasks(botId: string | undefined): { tasks: CloudTaskSummary[] | null; error: string | null } {
  const [tasks, setTasks] = useState<CloudTaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!botId) return;
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let delay = 30_000;
      try {
        const { jobs } = await api<{ jobs: CloudTaskSummary[] }>(`/api/laterdog/jobs?bot=${encodeURIComponent(botId)}&limit=8`);
        if (stopped) return;
        rememberCloudTasks(jobs);
        setTasks(jobs);
        setError(null);
        if (jobs.some((job) => ACTIVE.has(job.state))) delay = 5_000;
      } catch (failure) {
        if (stopped) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      if (!stopped) next = setTimeout(() => void load(), delay);
    };
    void load();
    return () => { stopped = true; if (next) clearTimeout(next); };
  }, [botId]);
  return { tasks, error };
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
export const cloudTaskPatch = (jobId: string) => api<{ patch: string }>(`/api/laterdog/jobs/${jobId}/patch`);

const WAKEUP_SEND_ID = /^laterdog_([0-9a-f]{32})_\d+$/;
const WAKEUP_TEXT = /^later\.dog job [0-9a-f-]{36}: ([a-z_]+)\./;

/** A wake-up the supervisor sent a dog's chat when its cloud task moved: shown as a slim update line, not as the person's words. */
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

export type CloudTaskTone = "accent" | "success" | "warning" | "danger" | "muted";
export interface CloudTaskStatusView { label: string; tone: CloudTaskTone; live: boolean; detail?: string }

const SETTING_UP = new Set(["starting", "install", "clone", "setup"]);

export function cloudTaskStatus(entry: CloudTaskEntry | undefined): CloudTaskStatusView {
  const summary = entry?.summary;
  if (!summary) {
    if (entry?.missing) return { label: t("cloudTask.status.missing"), tone: "muted", live: false };
    if (entry?.error) return { label: t("cloudTask.status.unreachable"), tone: "warning", live: false, detail: entry.error };
    return { label: t("cloudTask.status.checking"), tone: "muted", live: false };
  }
  switch (summary.state) {
    case "queued": return summary.blocker ? { label: t("cloudTask.status.waiting"), tone: "muted", live: true, detail: summary.blocker } : { label: t("cloudTask.status.queued"), tone: "muted", live: true };
    case "preparing": case "submitting": return { label: t("cloudTask.status.starting"), tone: "accent", live: true };
    case "submission_unknown": return { label: t("cloudTask.status.attention"), tone: "warning", live: false, detail: summary.blocker };
    case "running":
      if (!summary.stage || SETTING_UP.has(summary.stage)) return { label: t("cloudTask.status.settingUp"), tone: "accent", live: true };
      if (summary.stage === "done") return { label: t("cloudTask.status.wrappingUp"), tone: "accent", live: true };
      return { label: t("cloudTask.status.working"), tone: "accent", live: true };
    case "collecting": return { label: t("cloudTask.status.collecting"), tone: "accent", live: true };
    case "publishing": return { label: t("cloudTask.status.publishing"), tone: "accent", live: true };
    case "verifying": return { label: t("cloudTask.status.verifying"), tone: "accent", live: true };
    case "ready":
      if (summary.prUrl) return { label: summary.prNumber ? t("cloudTask.status.prNumber", { number: summary.prNumber }) : t("cloudTask.status.pr"), tone: "success", live: false, detail: summary.blocker };
      if (summary.changes && summary.changes.files === 0) return { label: t("cloudTask.status.noChanges"), tone: "muted", live: false, detail: summary.blocker };
      return { label: t("cloudTask.status.ready"), tone: "success", live: false };
    case "needs_attention": return { label: t("cloudTask.status.attention"), tone: "danger", live: false, detail: summary.blocker };
    case "cancelled": return { label: t("cloudTask.status.stopped"), tone: "muted", live: false };
    case "merged": return { label: t("cloudTask.status.merged"), tone: "success", live: false };
    default: return { label: summary.state, tone: "muted", live: false };
  }
}

export const TONE_CLASS: Record<CloudTaskTone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-ink-secondary",
};

export function stageLabel(stage: string): string {
  switch (stage) {
    case "starting": return t("cloudTask.stage.starting");
    case "install": return t("cloudTask.stage.install");
    case "clone": return t("cloudTask.stage.clone");
    case "setup": return t("cloudTask.stage.setup");
    case "claude": return t("cloudTask.stage.claude");
    case "done": return t("cloudTask.stage.done");
    default: return stage;
  }
}

export function toolVerb(tool: string): string {
  switch (tool) {
    case "Bash": return t("cloudTask.tool.ran");
    case "Read": return t("cloudTask.tool.read");
    case "Edit": case "MultiEdit": case "NotebookEdit": return t("cloudTask.tool.edited");
    case "Write": return t("cloudTask.tool.wrote");
    case "Grep": return t("cloudTask.tool.searched");
    case "Glob": return t("cloudTask.tool.looked");
    case "WebFetch": return t("cloudTask.tool.opened");
    case "WebSearch": return t("cloudTask.tool.searchedWeb");
    case "Task": case "Agent": return t("cloudTask.tool.helper");
    default: return tool;
  }
}

export function stepHeadline(step: CloudTaskStep): string {
  switch (step.k) {
    case "stage": return stageLabel(step.stage);
    case "say": return step.text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    case "tool": return step.detail ? `${toolVerb(step.tool)} ${step.detail}` : toolVerb(step.tool);
    case "plan": return t("cloudTask.step.plan");
    case "error": return step.text;
    case "done": return step.ok ? t("cloudTask.step.done") : t("cloudTask.step.stopped");
  }
}

export function changesLabel(changes: { files: number; additions: number; deletions: number }): string {
  return changes.files === 1
    ? t("cloudTask.changes.one", { additions: changes.additions, deletions: changes.deletions })
    : t("cloudTask.changes", { files: changes.files, additions: changes.additions, deletions: changes.deletions });
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
