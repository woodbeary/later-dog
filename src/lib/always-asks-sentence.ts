import { ALWAYS_ASK_IDS, ALWAYS_ASK_WORDS, type AlwaysAskId } from "../../shared/always-asks";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "./i18n";

const WORDS: Record<AlwaysAskId, LocaleKey> = ALWAYS_ASK_WORDS;

export function alwaysAsksSentence(): string {
  const list = new Intl.ListFormat(activeLocale(), { type: "disjunction" }).format(ALWAYS_ASK_IDS.map((id) => t(WORDS[id])));
  return t("askFirst.always", { list });
}
