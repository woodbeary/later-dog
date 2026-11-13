import type { TaskUsage } from "../../shared/wire.ts";
import { modelContextWindow } from "../model-context-window.ts";

export type SavedChatContext = NonNullable<TaskUsage["context"]>;

const UNSOURCED_LEGACY_WINDOW = 200_000;
const RESTATED_LEGACY_MODEL = /(?:^|:)(claude-fable-5(?:[-.][12])?)$/;

export function chatContext(
  task: { usage?: TaskUsage; lastContextModel?: string },
  currentModel: string | undefined,
): SavedChatContext | undefined {
  const context = task.usage?.context;
  if (context?.window !== UNSOURCED_LEGACY_WINDOW || context.windowSource !== undefined) return context;
  const legacyModel = (task.lastContextModel ?? currentModel)?.match(RESTATED_LEGACY_MODEL)?.[1];
  const window = modelContextWindow(legacyModel);
  return window !== undefined && window > UNSOURCED_LEGACY_WINDOW ? { ...context, window, windowSource: "model" } : context;
}
