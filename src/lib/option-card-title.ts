import { t } from "@/lib/i18n";
import type { OptionCardData } from "@/state/store";

export function optionCardTitle(card: Pick<OptionCardData, "title" | "requestId" | "requestType">, botName?: string): string {
  if (!card.requestId || card.requestType !== "question") return card.title;
  return botName ? t("question.card.named", { name: botName }) : t("question.card.title");
}
