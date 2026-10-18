export function botShowsUnread(bot: {
  threadId?: string;
  unread?: boolean;
  tasks?: ReadonlyArray<{ threadId: string; unread?: boolean }> | null;
}): boolean {
  if (!bot.tasks?.length || bot.threadId === undefined) return Boolean(bot.unread);
  return Boolean(bot.tasks.find((task) => task.threadId === bot.threadId)?.unread);
}
