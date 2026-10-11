import type { TurnImageInput } from "../contracts.ts";
import { extractTurnImages } from "../turn-images.ts";

export function steerWords(prompt: string): { text: string; images?: TurnImageInput[] } {
  const resolved = extractTurnImages(prompt);
  return resolved.images.length > 0 ? { text: resolved.text, images: resolved.images } : { text: prompt };
}
