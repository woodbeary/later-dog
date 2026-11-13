import type { NativeActivity, NativeActorState } from "../../shared/native-runs";
import { COMMAND_WORDS, FILE_CHANGE_WORDS, UNKNOWN_STEP_WORDS, toolStepWords, type StepWords } from "../../shared/step-words";
import { t } from "./i18n";

const HELPER_PROMPT = "Subagent instructions";
const FILE_CHANGES = "File changes";
const FINISHED: ReadonlySet<NativeActorState> = new Set(["done", "failed", "stopped"]);

function sentence(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function kindWords(activity: NativeActivity): StepWords | null {
  switch (activity.kind) {
    case "reasoning": return { now: t("work.step.thinking"), done: t("work.step.thought") };
    case "message": return activity.label === HELPER_PROMPT
      ? { now: t("work.step.instructions"), done: t("work.step.instructionsDone") }
      : { now: t("work.step.writing"), done: t("work.step.wrote") };
    case "plan": return { now: t("work.step.plan"), done: t("work.step.planDone") };
    case "compaction": return { now: t("work.step.roomToWork"), done: t("work.step.roomToWorkDone") };
    case "request": return { now: t("work.step.answer"), done: t("work.step.answerDone") };
    case "hook":
    case "notice": return { now: t("work.step.note"), done: t("work.step.note") };
    default: return null;
  }
}

function toolWords(activity: NativeActivity, provider: string | undefined): StepWords {
  if (activity.kind === "search") return toolStepWords("web_search", activity.input) ?? UNKNOWN_STEP_WORDS;
  if (activity.label === FILE_CHANGES) return FILE_CHANGE_WORDS;
  if (provider && /codex/i.test(provider) && activity.input !== undefined && activity.label === activity.input.slice(0, 240)) return COMMAND_WORDS;
  return toolStepWords(activity.label, activity.input) ?? UNKNOWN_STEP_WORDS;
}

export function nativeStepWord(activity: NativeActivity, provider?: string): string {
  const pair = kindWords(activity) ?? toolWords(activity, provider);
  return sentence(FINISHED.has(activity.state) ? pair.done : pair.now);
}

export function rawStepName(activity: NativeActivity): string | undefined {
  return activity.kind === "message" || activity.kind === "reasoning" ? undefined : activity.label;
}
