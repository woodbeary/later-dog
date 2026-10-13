import { useSyncExternalStore } from "react";
import { applyHelperUpdate, type Helper, type HelperMember, type HelperState } from "../../shared/helpers";
import type { RuntimeEvent } from "../../shared/runtime-events";

export type ThreadHelpers = Record<string, Helper[]>;

export const HELPER_SETTLED_SHOW_MS = 8_000;
const TURN_SLACK_MS = 1_000;
const STATES = new Set<string>(["running", "done", "failed", "stopped"]);
const NONE: Helper[] = [];

function fields(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function words(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stateOf(value: unknown): HelperState | undefined {
  return typeof value === "string" && STATES.has(value) ? value as HelperState : undefined;
}

function memberFrom(value: unknown): HelperMember | null {
  const raw = fields(value);
  const id = words(raw?.id);
  const state = stateOf(raw?.state);
  if (!raw || !id || !state) return null;
  return {
    id,
    label: words(raw.label) ?? "",
    state,
    phase: words(raw.phase),
    activity: words(raw.activity),
    toolUses: amount(raw.toolUses),
    tokens: amount(raw.tokens),
    durationMs: amount(raw.durationMs),
  };
}

export function helperFrom(value: unknown): Helper | null {
  const raw = fields(value);
  const id = words(raw?.id);
  const state = stateOf(raw?.state);
  const startedAt = amount(raw?.startedAt);
  if (!raw || !id || !state || startedAt === undefined) return null;
  const members = Array.isArray(raw.members)
    ? raw.members.map(memberFrom).filter((member): member is HelperMember => member !== null)
    : [];
  return {
    id,
    kind: raw.kind === "workflow" ? "workflow" : "agent",
    label: words(raw.label) ?? "",
    state,
    background: raw.background === true,
    startedAt,
    endedAt: amount(raw.endedAt),
    activity: words(raw.activity),
    summary: words(raw.summary),
    toolUses: amount(raw.toolUses),
    tokens: amount(raw.tokens),
    durationMs: amount(raw.durationMs),
    members: members.length > 0 ? members : undefined,
  };
}

export function helpersFromSnapshot(body: unknown): ThreadHelpers {
  const threads = fields(fields(body)?.helpers);
  const next: ThreadHelpers = {};
  if (!threads) return next;
  for (const [threadId, list] of Object.entries(threads)) {
    if (!threadId || !Array.isArray(list)) continue;
    let helpers: Helper[] = [];
    for (const entry of list) {
      const helper = helperFrom(entry);
      if (helper) helpers = applyHelperUpdate(helpers, helper);
    }
    if (helpers.length > 0) next[threadId] = helpers;
  }
  return next;
}

export function withHelperUpdate(current: ThreadHelpers, threadId: string, helper: Helper): ThreadHelpers {
  const before = current[threadId] ?? NONE;
  const after = applyHelperUpdate(before, helper);
  return after === before ? current : { ...current, [threadId]: after };
}

export function helperSettledAt(helper: Helper): number {
  return helper.endedAt ?? helper.startedAt + (helper.durationMs ?? 0);
}

export function helperInView(helper: Helper, now: number, turnStartedAt: number | null = null): boolean {
  if (helper.state === "running") return true;
  const thisTurn = turnStartedAt !== null && helper.startedAt >= turnStartedAt - TURN_SLACK_MS;
  if (helper.state === "failed" && thisTurn) return true;
  return now - helperSettledAt(helper) < HELPER_SETTLED_SHOW_MS;
}

export function helpersInView(helpers: readonly Helper[], now: number, turnStartedAt: number | null = null): Helper[] {
  return helpers.filter((helper) => helperInView(helper, now, turnStartedAt));
}

export function nextHelperChange(helpers: readonly Helper[], now: number): number | null {
  let next: number | null = null;
  for (const helper of helpers) {
    if (helper.state === "running") continue;
    const at = helperSettledAt(helper) + HELPER_SETTLED_SHOW_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

let threads: ThreadHelpers = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentHelpers(): ThreadHelpers {
  return threads;
}

export function receiveHelpersSnapshot(body: unknown): void {
  if (body == null) return;
  threads = helpersFromSnapshot(body);
  emit();
}

export function receiveHelperEvent(event: RuntimeEvent): boolean {
  if (event.type === "turn.started") {
    if (threads[event.threadId]) {
      threads = { ...threads };
      delete threads[event.threadId];
      emit();
    }
    return true;
  }
  if (event.type !== "helper.updated") return false;
  const helper = helperFrom(event.helper);
  if (!helper || !event.threadId) return true;
  const next = withHelperUpdate(threads, event.threadId, helper);
  if (next !== threads) {
    threads = next;
    emit();
  }
  return true;
}

export function forgetHelpers(): void {
  threads = {};
  emit();
}

export function useThreadHelpers(threadId: string | null | undefined): Helper[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? threads[threadId] ?? NONE : NONE),
    () => NONE,
  );
}
