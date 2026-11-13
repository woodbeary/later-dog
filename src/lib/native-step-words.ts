import type { NativeActivity } from "../../shared/native-runs";
import type { Message } from "@/state/store";
import { stepLabel } from "./live-activity";
import { t } from "./i18n";

export type StepMessage = Pick<Message, "kind" | "turnId" | "tool">;

const HELPER_PROMPT = "Subagent instructions";

function toolName(activity: NativeActivity): string {
  return activity.kind === "search" ? activity.label.split(":", 1)[0]!.trim() : activity.label;
}

function plainWithoutMatch(activity: NativeActivity): string {
  switch (activity.kind) {
    case "reasoning": return t("chat.activity.thinking");
    case "message": return activity.label === HELPER_PROMPT ? t("work.step.instructions") : t("work.step.writing");
    case "search": return t("chat.activity.searchWeb");
    case "plan": return t("work.step.plan");
    case "compaction": return t("work.step.roomToWork");
    case "request": return t("work.step.answer");
    case "hook":
    case "notice": return t("work.step.note");
    default: return stepLabel({ tool: { name: activity.label } });
  }
}

export function nativeStepWords(activities: readonly NativeActivity[], messages: readonly StepMessage[] = [], turnId?: string): Map<string, string> {
  const pool = messages.filter((message) => message.kind === "activity" && message.tool && (!turnId || message.turnId === turnId));
  const used = new Set<StepMessage>();
  const take = (found: (message: StepMessage) => boolean) => {
    const match = pool.find((message) => !used.has(message) && found(message));
    if (match) used.add(match);
    return match;
  };
  const words = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== "tool" && activity.kind !== "search") {
      words.set(activity.id, plainWithoutMatch(activity));
      continue;
    }
    const name = toolName(activity);
    const match = take((message) => message.tool!.name === name && (message.tool!.input ?? "") === (activity.input ?? ""))
      ?? take((message) => message.tool!.name === name);
    words.set(activity.id, match?.tool?.spoken?.trim() ? stepLabel(match) : plainWithoutMatch(activity));
  }
  return words;
}

export function rawStepName(activity: NativeActivity): string | undefined {
  return activity.kind === "message" || activity.kind === "reasoning" ? undefined : activity.label;
}
