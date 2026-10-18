import type { Message } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";

export interface TranscriptLookups {
  replyTarget(message: Message): Message | undefined;
  retryableId: string | undefined;
}

export function transcriptLookups(all: readonly Message[], branch: readonly Message[]): TranscriptLookups {
  const byId = new Map<string, Message>();
  for (const message of all) byId.set(message.id, message);
  let retryableId: string | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i]!;
    if (message.kind !== "digest" && message.kind !== "compaction") {
      retryableId = message.id;
      break;
    }
  }
  return {
    replyTarget: (message) => (message.replyToId ? byId.get(message.replyToId) : undefined),
    retryableId,
  };
}

export function localDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

let dates: { locale: string; format: (at: number) => string } | null = null;

export function dayLabel(at: number, today = localDay(Date.now())): string {
  const daysAgo = today - localDay(at);
  if (daysAgo === 0) return t("chat.day.today");
  if (daysAgo === 1) return t("chat.day.yesterday");
  if (Number.isNaN(daysAgo)) return "Invalid Date";
  const locale = activeLocale();
  if (dates?.locale !== locale) {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    dates = { locale, format: (value) => formatter.format(value) };
  }
  return dates.format(at);
}
