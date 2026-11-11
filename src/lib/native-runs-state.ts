import { useEffect, useSyncExternalStore } from "react";
import type { NativeRun, NativeRunList } from "../../shared/native-runs";
import { api } from "@/lib/api";
import { applyNativeRun, nativeReceiptAnchors } from "../../shared/native-run-selectors";

const empty: NativeRun[] = [];
let threads: Record<string, NativeRun[]> = {};
let epoch = 0;
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<void>>();
const loaded = new Set<string>();
const cursors = new Map<string, string>();
const errors = new Map<string, string>();
const incomplete = new Set<string>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function currentNativeRuns(threadId: string): NativeRun[] { return threads[threadId] ?? empty; }

export function receiveNativeRun(run: NativeRun): void {
  const previous = currentNativeRuns(run?.threadId);
  const rows = applyNativeRun(previous, run);
  if (rows === previous) return;
  threads = { ...threads, [run.threadId]: rows as NativeRun[] };
  emit();
}

export function forgetNativeRuns(): void {
  epoch += 1;
  threads = {};
  pending.clear();
  loaded.clear();
  cursors.clear();
  errors.clear();
  incomplete.clear();
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
    if (result.historyIncomplete) incomplete.add(threadId);
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

export function nativeHistoryIncomplete(threadId: string): boolean { return incomplete.has(threadId); }

export function useNativeHistoryIncomplete(threadId: string): boolean {
  return useSyncExternalStore(subscribe, () => nativeHistoryIncomplete(threadId), () => false);
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

export { nativeReceiptAnchors };
