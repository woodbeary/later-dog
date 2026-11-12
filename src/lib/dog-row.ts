import { currentTaskBot, visibleMessages, type AppState, type Bot } from "@/state/store";
import { botShowsUnread } from "./bot-unread";
import { sidebarWorkLine } from "./work-state";

export interface DogRowFacts {
  waiting: boolean;
  working: boolean;
  teammates: boolean;
  queued: boolean;
  unread: boolean;
  work: string | null;
}

export function dogRowFacts(bot: Bot, pendingQueued: AppState["pendingQueued"]): DogRowFacts {
  const current = currentTaskBot(bot);
  const waiting = current.activity === "waiting-on-you" || visibleMessages(current).some((message) => message.needsYou?.status === "waiting");
  const working = !waiting && (Boolean(current.busy) || current.activity === "working");
  const teammates = !waiting && !working && Boolean(current.waitingForTeammates);
  const queued = Boolean(pendingQueued[bot.threadId]?.length);
  return { waiting, working, teammates, queued, unread: botShowsUnread(bot), work: waiting ? null : sidebarWorkLine(current.work) };
}
