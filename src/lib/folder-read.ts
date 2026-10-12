import type { Bot, BotAnnouncement } from "@/state/store";

type FolderBot = Pick<Bot, "id" | "threadId" | "unread" | "tasks">;

export function folderUnreadThreadIds(bot: FolderBot, projectId: string): string[] {
  return (bot.tasks ?? [])
    .filter((task) => task.projectId === projectId && (task.unread ?? (task.threadId === bot.threadId && bot.unread)))
    .map((task) => task.threadId);
}

export async function markFolderRead(
  bot: FolderBot,
  projectId: string,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  for (const threadId of folderUnreadThreadIds(bot, projectId)) {
    const result = await request(`/api/bots/${bot.id}/read`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
    onRead(result.bot);
  }
}
