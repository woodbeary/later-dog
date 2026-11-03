import type { Surface } from "./wire.ts";

export const MAC_ALLOW_KEY = "mac";
export const DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY = "Delete folders outside its workspace";

export function cloudHomeOffersPlace(place: Surface): boolean {
  return place !== "local" && place !== "vm";
}
