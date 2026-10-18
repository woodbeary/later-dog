import { visibleMessages, type Bot } from "@/state/store";

export function waitingOnPerson(bot: Pick<Bot, "messages" | "activeLeafId"> | undefined): boolean {
  if (!bot) return false;
  return visibleMessages(bot).some((message) => message.kind === "options" && Boolean(message.card?.requestId)
    && !message.card?.answered && !message.card?.dismissed && !message.card?.expired);
}
