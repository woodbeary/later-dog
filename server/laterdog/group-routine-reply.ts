import type { WireMessage } from "../../shared/wire.ts";

type GroupLine = Pick<WireMessage, "id" | "role" | "kind" | "text" | "attachments" | "card" | "from">;

export const SILENT_GROUP_ROUTINE = "The dog finished without replying in the group chat.";

const REPLIED_WITHOUT_WORDS = "Replied in the group chat.";

function answers(line: GroupLine, botId: string): boolean {
  if (line.role !== "bot" || line.from?.botId !== botId) return false;
  if (line.kind === "text") return Boolean(line.text?.trim() || line.attachments?.length);
  return line.kind === "options" && line.card?.requestType !== "permission";
}

function words(line: GroupLine): string {
  return line.text?.trim() || (line.kind === "options" ? line.card?.title?.trim() ?? "" : "");
}

export function groupRoutineReply(messages: readonly GroupLine[], afterMessageId: string, botId: string): string | null {
  const start = messages.findIndex((line) => line.id === afterMessageId);
  const replies = messages.slice(start + 1).filter((line) => answers(line, botId));
  if (!replies.length) return null;
  const said = replies.map(words).findLast(Boolean);
  return said || REPLIED_WITHOUT_WORDS;
}
