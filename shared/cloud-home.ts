import type { Surface } from "./wire.ts";

export const MAC_ALLOW_KEY = "mac";

export function cloudHomeOffersPlace(place: Surface): boolean {
  return place !== "local" && place !== "vm";
}
