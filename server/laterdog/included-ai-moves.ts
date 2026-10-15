import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { Store } from "../store.ts";
import { includedSelectionNow } from "./included-ai.ts";

export function moveRetiredIncludedModels(store: Pick<Store, "bots" | "patchBot" | "patchTask">): number {
  let moved = 0;
  for (const bot of store.bots) {
    const selection = includedSelectionNow(bot.modelSelection);
    const fallback = bot.fallback?.map((entry) => includedSelectionNow(entry));
    const fallbackMoved = Boolean(fallback?.some((entry, index) => entry !== bot.fallback?.[index]));
    if (selection !== bot.modelSelection || fallbackMoved) {
      store.patchBot(bot.id, { ...(selection !== bot.modelSelection ? { modelSelection: selection } : {}), ...(fallbackMoved ? { fallback } : {}) });
      moved++;
    }
    for (const task of bot.tasks ?? []) {
      if (!task.modelSelection) continue;
      const next = includedSelectionNow(task.modelSelection);
      if (next === task.modelSelection) continue;
      store.patchTask(bot.id, task.threadId, { modelSelection: next });
      moved++;
    }
  }
  return moved;
}

export function moveRetiredIncludedDefault(
  cfg: Pick<AppConfig, "defaultModelSelection" | "newBotDefaults">,
  save: (patch: { defaultModelSelection: ModelSelection }) => void,
): boolean {
  const saved = cfg.defaultModelSelection;
  const next = saved && includedSelectionNow(saved);
  if (!next || next === saved) return false;
  save({ defaultModelSelection: next });
  cfg.defaultModelSelection = next;
  if (cfg.newBotDefaults) cfg.newBotDefaults = { ...cfg.newBotDefaults, profile: { ...cfg.newBotDefaults.profile, modelSelection: next } };
  return true;
}
