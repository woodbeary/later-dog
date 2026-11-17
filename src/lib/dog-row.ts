import { currentTaskBot, visibleMessages, type AppState, type Bot } from "@/state/store";
import { helpersLine, stepPhrase, type LiveStep } from "../../shared/step-words";
import { botShowsUnread } from "./bot-unread";
import { sidebarWorkLine, somethingRunsFor } from "./work-state";

export type RowDot = "working" | "waiting" | "unread";

export interface DogRowFacts {
  waiting: boolean;
  working: boolean;
  teammates: boolean;
  queued: boolean;
  unread: boolean;
  work: string | null;
  step: string | null;
  helperAsk: string | null;
  dot: RowDot | null;
}

type Stepped = { step?: LiveStep | null };

function liveStepOf(bot: Bot): LiveStep | null {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  return ((task ?? bot) as Stepped).step ?? null;
}

export function dogRowFacts(bot: Bot, pendingQueued: AppState["pendingQueued"]): DogRowFacts {
  const current = currentTaskBot(bot);
  const waiting = current.activity === "waiting-on-you" || visibleMessages(current).some((message) => message.needsYou?.status === "waiting");
  const working = !waiting && (Boolean(current.busy) || current.activity === "working");
  const teammates = !waiting && !working && Boolean(current.waitingForTeammates);
  const queued = Boolean(pendingQueued[bot.threadId]?.length);
  const unread = botShowsUnread(bot);
  const live = liveStepOf(bot);
  const helpers = waiting ? null : helpersLine(current.waitingOn ?? []);
  const busy = !waiting && (working || somethingRunsFor(current));
  return {
    waiting,
    working,
    teammates,
    queued,
    unread,
    work: waiting ? null : sidebarWorkLine(current.work),
    step: working ? (live ? stepPhrase(live.kind, live.id) : stepPhrase("working", "")) : null,
    helperAsk: helpers?.needsYou ? helpers.text : null,
    dot: waiting ? "waiting" : busy ? "working" : unread ? "unread" : null,
  };
}
