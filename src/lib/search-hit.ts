export interface SearchHit {
  botId?: string;
  groupId?: string;
  name: string;
  threadId: string;
  task?: string;
  messageId: string;
  role: string;
  kind: string;
  from?: string;
  at: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  onActivePath: boolean;
}

interface ConversationOwners {
  bots: ReadonlyArray<{ id: string; threadId: string }>;
  groups: ReadonlyArray<{ id: string; threadId: string; dm?: boolean }>;
}

export function inOneConversation(hit: Pick<SearchHit, "botId" | "groupId" | "threadId">, owners: ConversationOwners): boolean {
  if (hit.botId) return owners.bots.some((bot) => bot.id === hit.botId && bot.threadId === hit.threadId);
  if (hit.groupId) return owners.groups.some((group) => group.id === hit.groupId && !group.dm && group.threadId === hit.threadId);
  return false;
}
