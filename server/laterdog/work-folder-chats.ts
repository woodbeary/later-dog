import { join } from "node:path";
import type { BotRecord, GroupRecord } from "../store.ts";
import type { WorkspaceTask } from "./janitor.ts";
import type { ThreadState } from "./process-reaper.ts";

export interface WorkFolderChatsDeps {
  workspacesDir: string;
  bots: readonly Pick<BotRecord, "id" | "threadId" | "tasks">[];
  groups: readonly Pick<GroupRecord, "threadId" | "tasks" | "memberIds">[];
  damaged?: readonly { name: string }[];
  thread(botId: string, threadId: string): ThreadState;
  atWork(threadId: string): boolean;
}

export function workFolderChats(deps: WorkFolderChatsDeps): WorkspaceTask[] {
  if (deps.damaged?.some((file) => file.name === "bots" || file.name === "groups"))
    throw new Error("The saved chat records could not be read.");
  const chats = new Map<string, WorkspaceTask>();
  const add = (botId: string, threadId: string) => {
    const state = deps.thread(botId, threadId);
    if (!state.exists) return;
    const dir = join(deps.workspacesDir, botId, threadId);
    chats.set(dir, {
      dir,
      busy: state.busy || deps.atWork(threadId),
      closed: state.closed,
      lastActiveAt: state.lastActiveAt,
    });
  };
  const bots = new Set(deps.bots.map((bot) => bot.id));
  for (const bot of deps.bots) {
    for (const threadId of new Set([
      bot.threadId,
      ...(bot.tasks ?? []).map((task) => task.threadId),
    ]))
      add(bot.id, threadId);
  }
  for (const group of deps.groups) {
    for (const botId of group.memberIds) {
      if (!bots.has(botId)) continue;
      for (const threadId of new Set([
        group.threadId,
        ...(group.tasks ?? []).map((task) => task.threadId),
      ]))
        add(botId, threadId);
    }
  }
  return [...chats.values()];
}
