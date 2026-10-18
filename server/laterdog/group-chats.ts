import { sectionKey, type BotRecord, type GroupRecord } from "../store.ts";

export function mayMakeGroupChats(bot: Pick<BotRecord, "hidden"> | null | undefined): boolean {
  return bot != null && bot.hidden !== true;
}

export const GROUP_CHAT_REFUSAL = "This bot is archived, so it cannot make or change group chats. Ask the person to restore it first.";

export function groupChatMadeText(room: { id?: unknown; name?: unknown; memberCount?: unknown }, asked: { name: string; members: number }): string {
  const name = typeof room.name === "string" && room.name.trim() ? room.name.trim() : asked.name;
  const members = typeof room.memberCount === "number" ? room.memberCount : asked.members + 1;
  return `Created the group chat “${name}” [id: ${String(room.id)}] with ${members} members, you included. It is in the person's sidebar under Group chats now. Tell them so in one sentence, for example: "I've made the group chat ${name}, and it's in your sidebar now."`;
}

export type GroupChatListing = { id: string; name: string };

export function groupChatsOf(
  groups: readonly Pick<GroupRecord, "id" | "name" | "dm" | "memberIds" | "section">[],
  bot: Pick<BotRecord, "id" | "section">,
): GroupChatListing[] {
  return groups
    .filter((group) => !group.dm && group.memberIds.includes(bot.id) && sectionKey(group.section) === sectionKey(bot.section))
    .map((group) => ({ id: group.id, name: group.name }));
}

export function groupChatsText(rooms: unknown): string {
  const listed = Array.isArray(rooms)
    ? rooms.filter((room): room is GroupChatListing =>
      typeof room === "object" && room !== null && typeof (room as GroupChatListing).id === "string" && typeof (room as GroupChatListing).name === "string")
    : [];
  if (!listed.length) return "";
  return `Group chats you are in:\n${listed.map((room) => `- ${room.name} [id: ${room.id}]`).join("\n")}\n\nUse one of these ids as room_id with manage_room.`;
}
