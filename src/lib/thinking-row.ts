import type { LocaleKey } from "@/locales";
import type { ActivityKind } from "./live-activity";
import { t } from "./i18n";

export const ROTATE_MS = 4_500;
export const ROW_SHOW_DELAY_MS = 300;

const POOLS: Record<ActivityKind, readonly LocaleKey[]> = {
  thinking: ["chat.row.thinking.1", "chat.row.thinking.2", "chat.row.thinking.3", "chat.row.thinking.4"],
  reading: ["chat.row.reading.1", "chat.row.reading.2", "chat.row.reading.3"],
  writing: ["chat.row.writing.1", "chat.row.writing.2", "chat.row.writing.3"],
  editing: ["chat.row.editing.1", "chat.row.editing.2"],
  running: ["chat.row.running.1", "chat.row.running.2", "chat.row.running.3"],
  searching: ["chat.row.searching.1", "chat.row.searching.2", "chat.row.searching.3"],
  web: ["chat.row.web.1", "chat.row.web.2", "chat.row.web.3"],
  screen: ["chat.row.screen.1", "chat.row.screen.2"],
  computer: ["chat.row.computer.1", "chat.row.computer.2", "chat.row.computer.3"],
  page: ["chat.row.page.1", "chat.row.page.2"],
  team: ["chat.row.team.1", "chat.row.team.2"],
  working: ["chat.row.working.1", "chat.row.working.2", "chat.row.working.3"],
};

export function phrasePool(kind: ActivityKind): string[] {
  return POOLS[kind].map((key) => t(key));
}

export function rowPhrase(kind: ActivityKind, spoken: string | null, sinceKindMs: number): string {
  if (spoken) return spoken;
  const pool = phrasePool(kind);
  const turn = Math.floor(Math.max(0, sinceKindMs) / ROTATE_MS);
  return pool[turn % pool.length] ?? t("chat.activity.thinking");
}

export function rowElapsed(ms: number): string {
  if (ms < 60_000) return "";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
