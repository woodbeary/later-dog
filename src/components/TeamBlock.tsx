import { memo, useContext, useId, useMemo, useState } from "react";
import { openNotificationTarget, type Bot } from "@/state/store";
import { useDogsApartFromMessages, useRoomsApartFromMessages, useStoreDispatch } from "@/state/store-selectors";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { currentDogName } from "@/lib/dog-refs";
import { openExchange } from "@/lib/exchange-view";
import { TriangleAlert } from "lucide-react";
import { needsFirst, teamHeading, teamRows, unreachedNames, type FailedSendItem, type TeamItem, type TeamRow, type TeamState } from "@/lib/team-block";
import type { WireWaitingOn } from "../../shared/wire";
import { BotAvatar } from "./Avatar";
import { ExchangeThreadContext, QUIET_FACE_SIZE } from "./QuietLines";

export const TEAM_SHOWN = 6;

const STATE_WORDS: Record<TeamState, LocaleKey> = {
  Sent: "chat.team.state.sent",
  "Asked again": "chat.team.state.askedAgain",
  "Waiting its turn": "chat.team.state.queued",
  Working: "chat.team.state.working",
  "Needs you": "chat.team.state.needsYou",
  Done: "chat.team.state.done",
  "Stopped by you": "chat.team.state.stoppedByYou",
  Stopped: "chat.team.state.stopped",
  "Stopped by a local tool": "chat.team.state.localTool",
  "Was interrupted": "chat.team.state.interrupted",
  Removed: "chat.team.state.removed",
  "The chat that asked was deleted": "chat.team.state.askerDeleted",
  "Nothing moved for too long": "chat.team.state.idle",
  "Ran out of time": "chat.team.state.outOfTime",
  "Timed out twice": "chat.team.state.timedOut",
  "Reached the longest a task runs alone": "chat.team.state.ceiling",
  "Never got started": "chat.team.state.neverStarted",
  "Too many requests to the team": "chat.team.state.limit",
  "Stopped when later.dog restarted": "chat.team.state.restart",
  "Couldn't finish": "chat.team.state.couldNotFinish",
};

export function teamStateWords(state: TeamState): string {
  return t(STATE_WORDS[state]);
}

export function teamHeadingWords(rows: readonly TeamRow[]): string {
  const { dogs, done } = teamHeading(rows);
  const asked = dogs === 1 ? t("chat.team.askedOne") : t("chat.team.askedMany", { count: dogs });
  return done ? `${asked} · ${t("chat.team.done", { count: done })}` : asked;
}

function TeamRowLine({ row, bots }: { row: TeamRow; bots: readonly Bot[] }) {
  const dispatch = useStoreDispatch();
  const groups = useRoomsApartFromMessages();
  const ask = row.ask.row;
  const bot = bots.find((candidate) => candidate.id === ask.withBotId);
  const name = currentDogName(bots, ask.withBotId, ask.withName);
  const target = ask.target;
  const state = teamStateWords(row.state);
  const group = target.kind === "group" ? groups.find((candidate) => candidate.id === target.groupId) : undefined;
  const lead = ask.message.from?.name ?? group?.memberIds.map((id) => currentDogName(bots, id, "")).find((member) => member && member !== name) ?? "";
  const opens = row.helperThread || target.kind === "dog" ? t("chat.team.open", { name })
    : !group || group.dm ? t("chat.exchange.open", { first: lead, second: name })
      : t("chat.openConversationWith", { name: group.name });
  const open = () => {
    if (row.helperThread) {
      dispatch({ type: "select", id: ask.withBotId });
      dispatch({ type: "openTask", botId: ask.withBotId, threadId: row.helperThread });
    } else if (target.kind === "dog") openNotificationTarget(dispatch, target, { bots: [...bots], groups });
    else if (!group || group.dm) openExchange(target.groupId);
    else dispatch({ type: "select", id: target.groupId });
  };
  return (
    <li data-mid={ask.message.id} data-team-row={row.state}>
      <button
        type="button"
        onClick={open}
        title={opens}
        aria-label={`${name}: ${row.gist ? `${row.gist} · ` : ""}${state}`}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] leading-[18px] transition-colors hover:bg-raised-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
      >
        <BotAvatar bot={bot ?? { name, color: ask.withColor }} state="happy" size={QUIET_FACE_SIZE} motion="none" motionKey={0} animated={false} />
        <span data-team-name className="min-w-0 max-w-[45%] shrink-0 truncate text-ink">{name}</span>
        <span data-team-gist className="min-w-0 flex-1 truncate text-ink-tertiary">{row.gist}</span>
        <span data-team-state={row.state} className={cn("shrink-0", row.state === "Needs you" ? "font-medium text-ink" : "text-ink-secondary")}>{state}</span>
      </button>
    </li>
  );
}

export const TeamBlock = memo(function TeamBlock({ item, waitingOn }: { item: TeamItem; waitingOn?: readonly WireWaitingOn[] }) {
  const bots = useDogsApartFromMessages();
  const exchangeThread = useContext(ExchangeThreadContext);
  const [all, setAll] = useState(false);
  const list = useId();
  const rows = useMemo(() => {
    const present = new Set(bots.map((bot) => bot.id));
    return teamRows(item, exchangeThread?.thread ?? [], waitingOn, (botId) => present.has(botId));
  }, [item, exchangeThread?.thread, waitingOn, bots]);
  const ordered = needsFirst(rows);
  const shown = all || ordered.length <= TEAM_SHOWN ? ordered : ordered.slice(0, TEAM_SHOWN);
  return (
    <div data-team-block={item.asks.length} className="flex w-full min-w-0 flex-col items-center gap-1">
      <div data-team-heading className="px-1.5 text-[13px] leading-[18px] text-ink-secondary">{teamHeadingWords(rows)}</div>
      <ul id={list} className="w-full min-w-0 max-w-[560px] rounded-xl border border-hairline/50 bg-panel/50 p-1">
        {shown.map((row) => <TeamRowLine key={row.ask.row.message.id} row={row} bots={bots} />)}
      </ul>
      {rows.length > TEAM_SHOWN && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={list}
          onClick={() => setAll((value) => !value)}
          className="rounded-md px-1.5 text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {all ? t("chat.team.showFewer") : t("chat.team.showAll", { count: rows.length })}
        </button>
      )}
    </div>
  );
});

export function FailedSendLine({ item }: { item: FailedSendItem }) {
  const names = unreachedNames(item.message);
  const words = names ? t("chat.team.unreachedNamed", { names }) : t("chat.team.unreached");
  return (
    <div data-failed-send="" data-mid={item.message.id} className="flex w-full justify-center">
      <span role="status" className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-control/70 px-2 text-[12px] leading-4 text-danger">
        <TriangleAlert size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate font-medium">{words}</span>
      </span>
    </div>
  );
}
