import { plainClientError } from "@/lib/plain-client-error";

export type ChatPane = `chat:${string}`;
export type DogPanelPane = `dogPanel:${string}`;
export type PaneKey = "sidebar" | "routines" | "dogPanel" | "plugins" | ChatPane | DogPanelPane;

export interface PaneError {
  id: number;
  line: string;
  retryable: boolean;
}

export type PaneErrors = Partial<Record<PaneKey, PaneError>>;

export type PaneErrorAction =
  | { type: "paneError"; pane: PaneKey; error: PaneError }
  | { type: "paneErrorCleared"; pane: PaneKey; id?: number };

export type PaneRefresh = "chat" | "routines" | "models";

export const PANE_NOTICE_MS = 6_000;

export function chatPane(threadId: string): ChatPane {
  return `chat:${threadId}`;
}

export function dogPanelPane(botId: string): DogPanelPane {
  return `dogPanel:${botId}`;
}

export function withPaneError(errors: PaneErrors, pane: PaneKey, error: PaneError): PaneErrors {
  return { ...errors, [pane]: error };
}

function keepOnly(errors: PaneErrors, stays: (pane: PaneKey) => boolean): PaneErrors {
  const panes = Object.keys(errors) as PaneKey[];
  if (panes.every(stays)) return errors;
  const kept: PaneErrors = {};
  for (const pane of panes) if (stays(pane)) kept[pane] = errors[pane];
  return kept;
}

export function withoutPaneError(errors: PaneErrors, pane: PaneKey, id?: number): PaneErrors {
  const current = errors[pane];
  if (!current || (id !== undefined && current.id !== id)) return errors;
  return keepOnly(errors, (candidate) => candidate !== pane);
}

function refreshedBy(refresh: PaneRefresh, pane: PaneKey): boolean {
  if (refresh === "routines") return pane === "routines";
  if (refresh === "models") return pane === "dogPanel";
  return pane === "sidebar" || pane === "plugins" || pane.startsWith("chat:") || pane.startsWith("dogPanel:");
}

export function afterPaneRefresh(errors: PaneErrors, refresh: PaneRefresh): PaneErrors {
  return keepOnly(errors, (pane) => !refreshedBy(refresh, pane));
}

export function paneErrorsFor(errors: PaneErrors, panes: readonly PaneKey[]): { pane: PaneKey; error: PaneError } | null {
  for (const pane of panes) {
    const error = errors[pane];
    if (error) return { pane, error };
  }
  return null;
}

export interface PaneErrorDetails {
  line?: string;
  retry?: () => void;
}

export interface PaneErrorReporter {
  report: (error: unknown, pane?: PaneKey, details?: PaneErrorDetails) => void;
  retry: (pane: PaneKey) => void;
}

export function createPaneErrorReporter(deps: {
  dispatch: (action: PaneErrorAction) => void;
  fallbackPane: () => PaneKey;
  schedule?: (run: () => void, ms: number) => unknown;
}): PaneErrorReporter {
  let next = 0;
  const retries = new Map<PaneKey, { id: number; retry: () => void }>();
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  return {
    report(error, pane = deps.fallbackPane(), details = {}) {
      const id = ++next;
      if (details.retry) {
        retries.set(pane, { id, retry: details.retry });
      } else {
        retries.delete(pane);
        schedule(() => deps.dispatch({ type: "paneErrorCleared", pane, id }), PANE_NOTICE_MS);
      }
      deps.dispatch({
        type: "paneError",
        pane,
        error: { id, line: details.line ?? plainClientError(error), retryable: Boolean(details.retry) },
      });
    },
    retry(pane) {
      const entry = retries.get(pane);
      if (!entry) return;
      retries.delete(pane);
      deps.dispatch({ type: "paneErrorCleared", pane, id: entry.id });
      entry.retry();
    },
  };
}
