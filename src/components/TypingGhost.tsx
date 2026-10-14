import { t } from "@/lib/i18n";
import type { SuggestionSource } from "@/lib/use-typing-suggestion";

export function TypingGhost({ text, source }: { text: string; source: SuggestionSource | null }) {
  if (!text) return null;
  return <span data-typing-ghost data-ghost-source={source ?? undefined} className="text-ink-tertiary">{text}</span>;
}

export function TypingGhostAnnouncement({ text }: { text: string }) {
  return <span role="status" className="sr-only">{text ? t("composer.suggestion.announce", { text }) : ""}</span>;
}
