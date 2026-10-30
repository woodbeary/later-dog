import type { WireMessage } from "../shared/wire.ts";

export const SHOWN_PAGE_ROW_CAP = 1000;

const STATUS_STEP = /^(?:notice|recovery|error):/;

function shownActivity(message: WireMessage): boolean {
  const tool = message.tool;
  if (!tool?.name) return false;
  if (STATUS_STEP.test(tool.name) || message.threadRef || message.comm) return true;
  return tool.ok === false && Boolean(message.from || message.queueId);
}

export function shownInChat(message: WireMessage): boolean {
  if (message.kind === "secret" || message.card || message.cloudTask) return true;
  switch (message.kind) {
    case "activity":
      return shownActivity(message);
    case "text":
      return Boolean(message.text?.trim() || message.attachments?.length);
    case "screen":
    case "compaction":
      return true;
    case "routine.run":
      return Boolean(message.routineRun || message.text?.trim());
    case "connector":
      return Boolean(message.connector);
    default:
      return false;
  }
}

export function shownPageStart(messages: readonly WireMessage[], stop: number, shown: number, cap = SHOWN_PAGE_ROW_CAP): number {
  let start = stop;
  let counted = 0;
  while (start > 0 && counted < shown && stop - start < cap) {
    start -= 1;
    if (shownInChat(messages[start]!)) counted += 1;
  }
  return start;
}

export function briefStep(message: WireMessage): WireMessage {
  const tool = message.kind === "activity" ? message.tool : undefined;
  if (!tool || (tool.input === undefined && tool.output === undefined) || shownInChat(message)) return message;
  const { input: _input, output: _output, ...rest } = tool;
  return { ...message, tool: rest };
}
