import { currentTaskBot, visibleMessages, type AppState, type Bot } from "@/state/store";
import { helpersLine, stepPhrase, liveStep, type LiveStep } from "../../shared/step-words";
import type { NativeRun } from "../../shared/native-runs";
import { workLine } from "./work-line";
import { botShowsUnread } from "./bot-unread";
import { sidebarWorkLine } from "./work-state";

export type RowDot = "waiting" | "unread";

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

export function dogRowFacts(
  bot: Bot,
  pendingQueued: AppState["pendingQueued"],
  run?: NativeRun,
): DogRowFacts {
  const current = currentTaskBot(bot);
  const waiting =
    current.activity === "waiting-on-you" ||
    visibleMessages(current).some((message) => message.needsYou?.status === "waiting");
  const working = !waiting && (Boolean(current.busy) || current.activity === "working");
  const teammates = !waiting && !working && Boolean(current.waitingForTeammates);
  const queued = Boolean(pendingQueued[bot.threadId]?.length);
  const unread = botShowsUnread(bot);
  const live = liveStep(run) ?? liveStepOf(bot);
  const turnKey = `${bot.threadId}:${current.turnStartedAt ?? run?.id ?? "live"}`;
  const line = workLine({
    working,
    run,
    step: live,
    work: current.work,
    sideJobs: 0,
    now: Date.now(),
    turnKey,
  });
  const helpers = waiting ? null : helpersLine(current.waitingOn ?? []);
  return {
    waiting,
    working,
    teammates,
    queued,
    unread,
    work: waiting ? null : sidebarWorkLine(current.work),
    step: working
      ? line?.kind === "step"
        ? line.phrase
        : live
          ? stepPhrase(live.kind, turnKey)
          : stepPhrase("working", turnKey)
      : null,
    helperAsk: helpers?.needsYou ? helpers.text : null,
    dot: waiting || helpers?.needsYou ? "waiting" : unread ? "unread" : null,
  };
}
