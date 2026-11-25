import { useSyncExternalStore } from "react";

export type WorkPanelPage =
  | { kind: "work"; threadId: string; runId?: string }
  | { kind: "side-jobs"; threadId: string }
  | { kind: "step"; threadId: string; runId: string; activityId: string }
  | { kind: "side-job"; threadId: string; jobId: string }
  | { kind: "puppy"; threadId: string; runId: string; actorId: string };

let current: WorkPanelPage | null = null;
let opener: HTMLElement | null = null;
let below: WorkPanelPage[] = [];
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};
const pushed = (page: WorkPanelPage) =>
  page.kind === "step" || page.kind === "side-job" || page.kind === "puppy";

export function openWorkPanel(page: WorkPanelPage): void {
  if (current === null) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    opener =
      typeof HTMLElement !== "undefined" &&
      active instanceof HTMLElement &&
      active !== document.body
        ? active
        : null;
  }
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
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

export function useWorkPanelOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current !== null,
    () => false,
  );
}

export function workPanelOpener(): HTMLElement | null {
  return opener;
}
