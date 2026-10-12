import type { Surface } from "./wire.ts";

export function cloudHomeOffersPlace(place: Surface): boolean {
  return place !== "local" && place !== "vm";
}
