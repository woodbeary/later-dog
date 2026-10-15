import type { Message } from "@/state/store";
import { isFoldedStatusLine, isStatusActivity } from "./activity-runs";
import { stepLabel } from "./live-activity";

export interface TurnStep {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
}

export const STEP_LIMIT = 12;
export const UPDATE_LIMIT = 6;
const UPDATE_CHARS = 280;

function inTurn(message: Message, since: number | null): boolean {
  return since === null || message.at >= since;
}

export function turnSteps(messages: readonly Message[], since: number | null, limit: number = STEP_LIMIT): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "activity" || !message.tool) continue;
    if (message.comm || message.threadRef || message.cloudTask || isStatusActivity(message) || isFoldedStatusLine(message)) continue;
    if (!inTurn(message, since)) continue;
    const { ok } = message.tool;
    steps.push({ id: message.id, label: stepLabel(message), state: ok === undefined ? "running" : ok ? "done" : "failed" });
  }
  return steps.slice(-limit);
}

export function turnUpdates(
  messages: readonly Message[],
  hiddenIds: ReadonlySet<string>,
  since: number | null,
  limit: number = UPDATE_LIMIT,
): string[] {
  const said: string[] = [];
  for (const message of messages) {
    if (!hiddenIds.has(message.id) || message.role !== "bot" || message.kind !== "text" || !inTurn(message, since)) continue;
    const text = message.text?.trim();
    if (!text) continue;
    said.push(text.length > UPDATE_CHARS ? `${text.slice(0, UPDATE_CHARS - 1).trimEnd()}…` : text);
  }
  return said.slice(-limit);
}
