type Glance = Pick<Document, "hasFocus" | "visibilityState">;

type ViewedBot = {
  id: string;
  threadId: string;
  unread?: boolean;
  tasks?: ReadonlyArray<{ threadId: string; unread?: boolean }> | null;
};

type Viewed = {
  selectedId: string | null;
  bots: readonly ViewedBot[];
  groups: ReadonlyArray<{ id: string; unread?: boolean }>;
};

export type ReadRequest = { path: string; body?: string };

export function personIsLooking(glance: Glance | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return !glance || (glance.visibilityState !== "hidden" && glance.hasFocus());
}

export function selectedChatUnread(bot: ViewedBot): boolean {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  return Boolean(task?.unread || (!bot.tasks && bot.unread));
}

export function readWhenBack(state: Viewed): ReadRequest | null {
  if (!state.selectedId) return null;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (bot) {
    return selectedChatUnread(bot)
      ? { path: `/api/bots/${bot.id}/read`, body: JSON.stringify({ threadId: bot.threadId }) }
      : null;
  }
  const group = state.groups.find((candidate) => candidate.id === state.selectedId);
  return group?.unread ? { path: `/api/groups/${group.id}/read` } : null;
}
