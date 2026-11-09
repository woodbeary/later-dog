import { isPersistentQuestionCard, shouldSettleRequestCard } from "../../shared/ask-question.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { OptionCardData } from "../../shared/wire.ts";

export function requestCardResolution(card: OptionCardData, event: Extract<RuntimeEvent, { type: "request.resolved" }>): Partial<OptionCardData> | undefined {
  if (event.resolvedExternally) return { answered: "resolved", answeredText: /codex/i.test(event.provider) ? "Resolved by Codex" : "Resolved by the provider", dismissed: false };
  if (!shouldSettleRequestCard(card, event.source)) return;
  return { answered: event.behavior, dismissed: isPersistentQuestionCard(card) ? false : event.source !== "user" };
}
