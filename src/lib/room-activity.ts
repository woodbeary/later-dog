import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";
import { isReceipt } from "@/lib/receipts";

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

export function lastShownRow(messages: readonly Message[], showToolCalls: boolean): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (!isReceipt(message) && transcriptRowShown(message, showToolCalls)) return message;
  }
  return undefined;
}
