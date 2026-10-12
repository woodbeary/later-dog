import { cloudHomeOffersPlace } from "../../shared/cloud-home";
import { offersPlace } from "../../shared/places";
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { Bot, Task } from "@/state/store";
import type { LocaleKey } from "@/locales";

export type Place = "cloud" | "vm" | "local" | "browser";
export const PLACES: readonly Place[] = ["cloud", "local"];
export type EffectivePlace = Place | "auto" | "off";

export function placeOffered(place: Place, config: { cloudHome?: boolean } | null | undefined): boolean {
  return offersPlace(place) && (!config?.cloudHome || cloudHomeOffersPlace(place));
}

export function effectivePlace(bot: Pick<Bot, "computer">, task?: Pick<Task, "surface"> | null): EffectivePlace {
  if (bot.computer === "off") return "off";
  const pin = task?.surface;
  if (offersPlace(pin)) return pin;
  return offersPlace(bot.computer) ? bot.computer : "auto";
}

export function isComputerPlace(place: EffectivePlace): place is "cloud" | "vm" | "local" {
  return place === "cloud" || place === "vm" || place === "local";
}

export function placeLabelKey(place: EffectivePlace): LocaleKey {
  return `place.${place}` as LocaleKey;
}

export function toolPlace(toolName: string, effective: EffectivePlace): Place | null {
  const kind = toolSurfaceKind(toolName);
  if (kind === "browser") return "browser";
  if (kind === "computer") return isComputerPlace(effective) ? effective : null;
  return null;
}
