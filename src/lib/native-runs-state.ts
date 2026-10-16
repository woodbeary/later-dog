import { useEffect, useSyncExternalStore } from "react";
import type { NativeRun, NativeRunList } from "../../shared/native-runs";
import { api } from "@/state/store";

const empty: NativeRun[] = [];
let threads: Record<string, NativeRun[]> = {};
let epoch = 0;
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<void>>();
const loaded = new Set<string>();
const cursors = new Map<string, string>();
const errors = new Map<string, string>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function currentNativeRuns(threadId: string): NativeRun[] { return threads[threadId] ?? empty; }

export function receiveNativeRun(run: NativeRun): void {
  if (!run?.id || !run.threadId || !Array.isArray(run.actors)) return;
  const previous = currentNativeRuns(run.threadId);
  const index = previous.findIndex(row => row.id === run.id);
  const existing = previous[index];
  if (existing && existing.revision >= run.revision) return;
  const rows = [...previous];
  if (index === -1) rows.push(run);
  else rows[index] = run;
  if (existing?.startedAt !== run.startedAt) rows.sort((a, b) => b.startedAt - a.startedAt);
  threads = { ...threads, [run.threadId]: rows };
  emit();
}

export function forgetNativeRuns(): void {
  epoch += 1;
  threads = {};
  pending.clear();
  loaded.clear();
  cursors.clear();
  errors.clear();
  emit();
}

export function loadNativeRuns(threadId: string, options: { refresh?: boolean; older?: boolean } = {}): Promise<void> {
  const cursor = options.older ? cursors.get(threadId) : undefined;
  if (options.older && !cursor) return Promise.resolve();
  const key = `${threadId}:${cursor ?? "latest"}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (!options.refresh && !options.older && loaded.has(threadId)) return Promise.resolve();
  const startedEpoch = epoch;
  const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
  const request = api<NativeRunList>(`/api/threads/${encodeURIComponent(threadId)}/runs?${query}`).then(result => {
    if (epoch !== startedEpoch) return;
    for (const run of result.runs ?? []) receiveNativeRun(run);
    if (result.nextCursor) cursors.set(threadId, result.nextCursor);
    else cursors.delete(threadId);
    loaded.add(threadId);
    errors.delete(threadId);
  }).catch(error => {
    if (epoch !== startedEpoch) return;
    if (error?.status === 404) { loaded.add(threadId); cursors.delete(threadId); errors.delete(threadId); }
    else errors.set(threadId, error instanceof Error ? error.message : "Work history is unavailable.");
  }).finally(() => {
    if (epoch !== startedEpoch) return;
    pending.delete(key);
    emit();
  });
  pending.set(key, request);
  return request;
}

export function useNativeRuns(threadId: string | null | undefined, oldestMessageAt?: number): NativeRun[] {
  const runs = useSyncExternalStore(subscribe, () => threadId ? currentNativeRuns(threadId) : empty, () => empty);
  useEffect(() => { if (threadId) void loadNativeRuns(threadId); }, [threadId]);
  useEffect(() => {
    if (threadId && oldestMessageAt !== undefined && (runs.at(-1)?.startedAt ?? 0) > oldestMessageAt) void loadNativeRuns(threadId, { older: true });
  }, [threadId, oldestMessageAt, runs]);
  return runs;
}

export function refreshNativeRuns(): void {
  for (const threadId of new Set([...loaded, ...Object.keys(threads)])) void loadNativeRuns(threadId, { refresh: true });
}

export function nativeReceiptAnchors(runs: readonly NativeRun[], messages: readonly { id: string; turnId?: string; role: string; kind: string }[]): Map<string, NativeRun[]> {
  const anchors = new Map<string, NativeRun[]>();
  const answers = new Map<string, string>();
  for (const message of messages) if (message.turnId && message.role !== "user" && message.kind === "text") answers.set(message.turnId, message.id);
  for (const run of runs) {
    if (!run.endedAt && run.observation === "live") continue;
    const anchor = answers.get(run.turnId);
    if (anchor) anchors.set(anchor, [...(anchors.get(anchor) ?? []), run]);
  }
  return anchors;
}
