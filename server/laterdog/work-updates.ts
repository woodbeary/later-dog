import type { GuidanceEngine } from "./dog-guidance.ts";
import { TAPBACK_NOTE, TAPBACK_PROMPT } from "./tapback.ts";

export const QUIET_WORK_PROMPT =
  " The app already shows that you are working, so between your one-line updates do not narrate each step, tool, file or search. Screenshots you take are for you; do not describe them. When the person writes to you while you work, reply in a short line straight away, before your next tool call, then carry on.";
export const MILESTONE_PROMPT =
  " Leave out time estimates unless the person asks how long something will take.";

export const KEEP_GOING_PROMPT =
  " Nothing happens after your turn ends, so do not end it on a line about what you will do next, such as \"I'm checking it now\". Do the work in this turn, or say in one line what is stopping you.";

export const BACKGROUND_WORK_PROMPT =
  " You may end your turn while background work runs: you are told when it finishes, and then you report the result.";

export const KEEP_GOING_WITH_BACKGROUND_PROMPT =
  " Apart from background work, nothing happens after your turn ends, so do not end it on a line about what you will do next; do the work now, or say in one line what is stopping you.";
export const ON_IT_NOTE = `[later.dog note, not typed by the person: if this needs a tool, send your one short on-it line first, before the first tool call. A react tapback needs no on-it line.${TAPBACK_NOTE}]`;

export const SHORT_ON_IT_NOTE = `[later.dog note, not typed by the person: If you will use a tool, say in one line what you are doing first; otherwise just answer.${TAPBACK_NOTE}]`;

export function withOnItNote(text: string, engine?: GuidanceEngine): string {
  return `${text}\n\n${engine === "other" ? SHORT_ON_IT_NOTE : ON_IT_NOTE}`;
}

export const STEER_NOTE = `[later.dog note, not typed by the person: the person sent this while you were working. Reply to it now in a short line, before your next tool call, then carry on with any change it asks for.${TAPBACK_NOTE}]`;

export function withSteerNote(text: string): string {
  return `${text}\n\n${STEER_NOTE}`;
}

export function workUpdatesPrompt({ background = false, react = false }: { background?: boolean; react?: boolean } = {}): string {
  return QUIET_WORK_PROMPT + MILESTONE_PROMPT + (background ? BACKGROUND_WORK_PROMPT + KEEP_GOING_WITH_BACKGROUND_PROMPT : KEEP_GOING_PROMPT) + (react ? TAPBACK_PROMPT : "");
}

export function quietWorkEnvironment(quiet: boolean | undefined): Record<string, string> {
  return quiet ? { CLAUDE_CODE_SILENT_TURN_REMINDER: "0" } : {};
}
