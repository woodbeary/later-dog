import type { Surface } from "./wire.ts";

export type OfferedPlace = Extract<Surface, "cloud" | "local">;

export function offersPlace(place: unknown): place is OfferedPlace {
  return place === "cloud" || place === "local";
}
