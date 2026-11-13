import type { OptionCardData } from "@/state/store";

export const MAIN_NATIVE_ACTOR = "parent";

export function helperWhoAsked(card: Pick<OptionCardData, "nativeActorId" | "nativeActorLabel">): string | undefined {
  return card.nativeActorId && card.nativeActorId !== MAIN_NATIVE_ACTOR ? card.nativeActorLabel || undefined : undefined;
}
