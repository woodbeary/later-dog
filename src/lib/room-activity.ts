import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";

export function roomActivityVisible(message: Message, showToolCalls: boolean): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || message.cloudTask || isStatusActivity(message)) return true;
  return tool.ok === false || failedTurnCause(tool.name) !== null || showToolCalls;
}

export function transcriptRowShown(message: Message, showToolCalls: boolean): boolean {
  if (message.kind === "digest") return showToolCalls;
  if (message.kind !== "activity") return true;
  return roomActivityVisible(message, showToolCalls);
}
