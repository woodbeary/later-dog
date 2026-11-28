import { join } from "node:path";
import type { BotRecord, GroupRecord } from "../store.ts";
import type { WorkspaceTask } from "./janitor.ts";
import type { ThreadState } from "./process-reaper.ts";
import { scanYielding } from "./yielding-scan.ts";

export interface WorkFolderChatsDeps {
  workspacesDir: string;
  bots: readonly Pick<BotRecord, "id" | "threadId" | "tasks">[];
  groups: readonly Pick<GroupRecord, "threadId" | "tasks" | "memberIds">[];
  damaged?: readonly { name: string }[];
  thread(botId: string, threadId: string): ThreadState;
  atWork(threadId: string): boolean;
}

type ChatKey = readonly [botId: string, threadId: string];

function chatKeys(deps: WorkFolderChatsDeps): ChatKey[] {
  if (deps.damaged?.some(file => file.name === "bots" || file.name === "groups")) throw new Error("The saved chat records could not be read.");
  const keys = new Map<string, ChatKey>();
  const add = (botId: string, threadId: string) => { keys.set(join(botId, threadId), [botId, threadId]); };
  const bots = new Set(deps.bots.map(bot => bot.id));
  for (const bot of deps.bots) {
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)])) add(bot.id, threadId);
  }
  for (const group of deps.groups) {
    for (const botId of group.memberIds) {
      if (!bots.has(botId)) continue;
      for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])) add(botId, threadId);
    }
  }
  return [...keys.values()];
}

function chatOf(deps: WorkFolderChatsDeps, [botId, threadId]: ChatKey): WorkspaceTask | null {
  const state = deps.thread(botId, threadId);
  if (!state.exists) return null;
  return { dir: join(deps.workspacesDir, botId, threadId), busy: state.busy || deps.atWork(threadId), closed: state.closed, lastActiveAt: state.lastActiveAt };
}

export function workFolderChats(deps: WorkFolderChatsDeps): WorkspaceTask[] {
  return chatKeys(deps).map(key => chatOf(deps, key)).filter((chat): chat is WorkspaceTask => chat !== null);
}

export async function workFolderChatsInSlices(deps: WorkFolderChatsDeps, pass?: () => Promise<void>): Promise<WorkspaceTask[]> {
  const chats: WorkspaceTask[] = [];
  await scanYielding(chatKeys(deps), (key) => { const chat = chatOf(deps, key); if (chat) chats.push(chat); }, pass ? { pass } : {});
  return chats;
}

export function workFolderChat(deps: WorkFolderChatsDeps, dir: string): WorkspaceTask | undefined {
  const key = chatKeys(deps).find(([botId, threadId]) => join(deps.workspacesDir, botId, threadId) === dir);
  return (key && chatOf(deps, key)) ?? undefined;
}
