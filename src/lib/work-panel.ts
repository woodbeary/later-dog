import { useSyncExternalStore } from "react";

export type WorkPanelPage =
  | { kind: "work"; threadId: string; runId?: string }
  | { kind: "side-jobs"; threadId: string }
  | { kind: "step"; threadId: string; runId: string; activityId: string }
  | { kind: "side-job"; threadId: string; jobId: string };

let current: WorkPanelPage | null = null;
let below: WorkPanelPage[] = [];
const listeners = new Set<() => void>();

const notify = () => { for (const listener of listeners) listener(); };
const pushed = (page: WorkPanelPage) => page.kind === "step" || page.kind === "side-job";

export function openWorkPanel(page: WorkPanelPage): void {
  below = current && pushed(page) && current.threadId === page.threadId ? [...below, current] : [];
  current = page;
  notify();
}

export function closeWorkPanel(): void {
  current = null;
  below = [];
  notify();
}

export function backWorkPanel(): void {
  current = below.at(-1) ?? null;
  below = below.slice(0, -1);
  notify();
}

export function workPanelCanGoBack(): boolean {
  return below.length > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkPanel(): WorkPanelPage | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
