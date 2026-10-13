import type { BotRecord } from "../store.ts";

export function mayMakeGroupChats(bot: Pick<BotRecord, "hidden"> | null | undefined): boolean {
  return bot != null && bot.hidden !== true;
}

export const GROUP_CHAT_REFUSAL = "This bot is archived, so it cannot make or change group chats. Ask the person to restore it first.";

export function groupChatMadeText(room: { id?: unknown; name?: unknown; memberCount?: unknown }, asked: { name: string; members: number }): string {
  const name = typeof room.name === "string" && room.name.trim() ? room.name.trim() : asked.name;
  const members = typeof room.memberCount === "number" ? room.memberCount : asked.members + 1;
  return `Created the group chat “${name}” [id: ${String(room.id)}] with ${members} members, you included. It is in the person's sidebar under Group chats now. Tell them so in one sentence, for example: "I've made the group chat ${name}, and it's in your sidebar now."`;
}
