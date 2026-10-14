import type { Message } from "@/state/store";
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

export type ActivityKind =
  | "thinking"
  | "reading"
  | "writing"
  | "editing"
  | "running"
  | "searching"
  | "web"
  | "screen"
  | "computer"
  | "page"
  | "team"
  | "working";

const FALLBACKS: Array<[RegExp, ActivityKind, LocaleKey]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command)\b/i, "running", "chat.activity.runCommand"],
  [/\b(?:read|read_file|view|open_file)\b/i, "reading", "chat.activity.readFile"],
  [/\b(?:write|write_file|create_file)\b/i, "writing", "chat.activity.writeFile"],
  [/\b(?:edit|apply_patch|replace|str_replace)\b/i, "editing", "chat.activity.editFile"],
  [/\b(?:web_search|search_web)\b/i, "web", "chat.activity.searchWeb"],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, "page", "chat.activity.readPage"],
  [/\b(?:grep|glob|find|search)\b/i, "searching", "chat.activity.searching"],
  [/\b(?:screenshot|screen_capture)\b/i, "screen", "chat.activity.screen"],
  [/\b(?:click|type|keypress|press|scroll|computer)\b/i, "computer", "chat.activity.computer"],
  [/\b(?:open_url|navigate)\b/i, "page", "chat.activity.openPage"],
  [/\b(?:list_bots|list_agents)\b/i, "team", "chat.activity.whosAround"],
  [/\blist_rooms\b/i, "team", "chat.activity.rooms"],
  [/\bpost_to_room\b/i, "team", "chat.activity.postRoom"],
  [/\bdelegate_bot\b/i, "team", "chat.activity.handoff"],
  [/\b(?:ask_bot|send_message)\b/i, "team", "chat.activity.askTeammate"],
];

function toolHead(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "").split(":", 1)[0] ?? "";
}

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return t("chat.activity.thinking");
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

export interface LiveActivity {
  kind: ActivityKind;
  spoken: string | null;
}

export function liveActivity(message?: Message): LiveActivity {
  if (message?.kind !== "activity" || !message.tool || message.tool.ok !== undefined || message.comm) {
    return { kind: "thinking", spoken: null };
  }
  const spoken = message.tool.spoken?.trim() ? sentenceCase(message.tool.spoken) : null;
  const head = toolHead(message.tool.name);
  const match = FALLBACKS.find(([pattern]) => pattern.test(head));
  return { kind: match?.[1] ?? "working", spoken };
}

export function stepLabel(message: Message): string {
  const tool = message.tool;
  if (!tool) return t("chat.activity.working");
  if (tool.spoken?.trim()) return sentenceCase(tool.spoken);
  const head = toolHead(tool.name);
  const match = FALLBACKS.find(([pattern]) => pattern.test(head));
  return match ? t(match[2]) : t("chat.activity.working");
}

export function liveActivityLabel(message?: Message): string {
  const live = liveActivity(message);
  if (live.spoken) return live.spoken;
  if (message?.kind !== "activity" || !message.tool || message.tool.ok !== undefined || message.comm) {
    return t("chat.activity.thinking");
  }
  return stepLabel(message);
}
