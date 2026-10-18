import { currentTaskBot, type AppState, type Bot } from "@/state/store";
import { botShowsUnread } from "./bot-unread";

export interface DogRowFacts {
  waiting: boolean;
  working: boolean;
  teammates: boolean;
  queued: boolean;
  unread: boolean;
}

export function dogRowFacts(bot: Bot, pendingQueued: AppState["pendingQueued"]): DogRowFacts {
  const current = currentTaskBot(bot);
  const waiting = current.activity === "waiting-on-you";
  const working = !waiting && (Boolean(current.busy) || current.activity === "working");
  const teammates = !waiting && !working && Boolean(current.waitingForTeammates);
  const queued = Boolean(pendingQueued[bot.threadId]?.length);
  return { waiting, working, teammates, queued, unread: botShowsUnread(bot) };
}
