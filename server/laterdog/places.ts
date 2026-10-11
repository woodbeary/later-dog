import { offersPlace } from "../../shared/places.ts";
import type { BotRecord } from "../store.ts";

export function retirePlaces(bot: BotRecord): boolean {
  let changed = false;
  if (bot.computer !== undefined && bot.computer !== "off" && !offersPlace(bot.computer)) {
    delete bot.computer;
    changed = true;
  }
  for (const task of bot.tasks ?? []) {
    if (task.surface === undefined || offersPlace(task.surface)) continue;
    delete task.surface;
    delete task.surfaceSource;
    changed = true;
  }
  return changed;
}

export function retireDefaultsPlace(profile: unknown): unknown {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
  const { computer, ...rest } = profile as Record<string, unknown>;
  return computer === "vm" || computer === "browser" ? rest : profile;
}
