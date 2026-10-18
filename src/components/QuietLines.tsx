import { memo, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Timer, TriangleAlert } from "lucide-react";
import { formatTime, openNotificationTarget, useStore, type AppState, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { currentDogName, freshenDogName } from "@/lib/dog-refs";
import { openExchange } from "@/lib/exchange-view";
import { exchangeWording, failedExchange, foldedPreview, sentExchange, singleExchange, type ExchangeItem, type ExchangeRow } from "@/lib/quiet-lines";
import { BotAvatar } from "./Avatar";

export const QUIET_FACE_SIZE = 14;

export function QuietLine({
  children,
  onClick,
  title,
  label,
  className,
  after,
  kind,
  expanded,
  controls,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  label?: string;
  className?: string;
  after?: ReactNode;
  kind?: string;
  expanded?: boolean;
  controls?: string;
}) {
  const body = "flex max-w-full items-center justify-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] leading-[18px] text-ink-secondary";
  return (
    <div data-quiet-line={kind ?? ""} className="flex w-full flex-wrap items-center justify-center gap-x-1">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={title}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          className={cn(body, "transition-colors duration-(--motion-micro) hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none", className)}
        >
          {children}
        </button>
      ) : (
        <div title={title} className={cn(body, className)}>{children}</div>
      )}
      {after}
    </div>
  );
}

export function PlainNoteLine({ message }: { message: Message }) {
  const { state } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === message.threadRef?.botId);
  return <QuietLine kind="note">{freshenDogName(tool.name, bot)}</QuietLine>;
}

const failureClass = "flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-control/70 px-2 text-[12px] leading-4 text-danger transition-colors hover:bg-raised hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function destinationTitle(row: ExchangeRow, state: AppState): string | undefined {
  const target = row.target;
  if (target.kind === "group") return state.groups.find(group => group.id === target.groupId)?.name;
  return currentDogName(state.bots, target.botId, row.withName);
}

function FailureResult({ row }: { row: ExchangeRow }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find(candidate => candidate.id === row.withBotId);
  const label = freshenDogName(row.message.tool!.name, bot, row.withName, { leading: true });
  const target = row.target;
  const group = target.kind === "group" ? state.groups.find(candidate => candidate.id === target.groupId) : undefined;
  const title = destinationTitle(row, state);
  const open = () => {
    if (target.kind === "dog") openNotificationTarget(dispatch, target, state);
    else if (!group || group.dm) openExchange(target.groupId);
    else dispatch({ type: "select", id: target.groupId });
  };
  return <button type="button" onClick={open} className={failureClass} title={title}>
    <TriangleAlert size={13} aria-hidden="true" className="shrink-0" />
    <span className="min-w-0 truncate font-medium">{label}</span>
    <ChevronRight size={12} aria-hidden="true" className="shrink-0" />
  </button>;
}

function FailedResultsLine({ item, forceOpen }: { item: ExchangeItem; forceOpen: boolean }) {
  const { state } = useStore();
  const [open, setOpen] = useState(forceOpen);
  const expanded = forceOpen || open;
  const details = useId();
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const first = item.rows[0]!;
  const bot = state.bots.find(candidate => candidate.id === first.withBotId);
  const caption = freshenDogName(first.message.tool!.name, bot, first.withName, { leading: true });
  if (item.rows.length === 1) return <div data-failed-results="" className="flex justify-start"><FailureResult row={first} /></div>;
  return <div data-failed-results="" className="flex min-w-0 flex-col items-start gap-1.5">
    <button type="button" className={failureClass} aria-expanded={expanded} aria-controls={details} onClick={() => setOpen(value => !value)}>
      <TriangleAlert size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate font-medium">{caption}</span>
      <span className="shrink-0 tabular-nums">· {item.rows.length}</span>
      <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
    </button>
    <div id={details} hidden={!expanded} className="w-full min-w-0 max-w-[560px]">
      {expanded && <ul className="space-y-2 rounded-xl border border-hairline/50 bg-panel/50 p-2">{item.rows.map(row => <li key={row.message.id} data-mid={row.message.id}><div>
        <FailureResult row={row} />
        <div className="mt-1 flex gap-1.5 px-2 text-[11px] text-ink-tertiary"><time dateTime={new Date(row.message.at).toISOString()}>{formatTime(row.message.at)}</time><span className="truncate">{destinationTitle(row, state)}</span></div>
        {typeof row.message.tool?.output === "string" && <p className="mt-1 whitespace-pre-wrap break-words px-2 text-[12px] text-ink-secondary">{row.message.tool.output}</p>}
      </div></li>)}</ul>}
    </div>
  </div>;
}

function SentMessagesLine({ item, forceOpen }: { item: ExchangeItem; forceOpen: boolean }) {
  const { state } = useStore();
  const [open, setOpen] = useState(forceOpen);
  const expanded = forceOpen || open;
  const details = useId();
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const first = item.rows[0]!;
  const bot = state.bots.find(candidate => candidate.id === item.withBotId);
  const name = currentDogName(state.bots, item.withBotId, first.withName);
  return <div data-sent-messages="" className="flex min-w-0 flex-col items-center gap-1.5">
    <QuietLine onClick={() => setOpen(value => !value)} expanded={expanded} controls={details}>
      <span>{t("chat.exchange.messaged")}</span>
      <BotAvatar bot={bot ?? { name, color: first.withColor }} state="happy" size={QUIET_FACE_SIZE} animated={false} />
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 tabular-nums">· {item.rows.length}</span>
      <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
    </QuietLine>
    <div id={details} hidden={!expanded} className="w-full min-w-0 max-w-[560px]">
      {expanded && <ul className="space-y-1.5 rounded-xl border border-hairline/50 bg-panel/50 p-2">{item.rows.map(row => <li key={row.message.id} data-mid={row.message.id}><div>
        <ExchangeLine item={singleExchange(row.message)!} />
        <div className="text-center text-[11px] text-ink-tertiary">{destinationTitle(row, state)} · {formatTime(row.message.at)}</div>
      </div></li>)}</ul>}
    </div>
  </div>;
}

export const ExchangeLine = memo(function ExchangeLine({ item, forceOpen = false }: { item: ExchangeItem; forceOpen?: boolean }) {
  const { state, dispatch } = useStore();
  if (failedExchange(item)) return <FailedResultsLine item={item} forceOpen={forceOpen} />;
  if (sentExchange(item) && item.rows.length > 1) return <SentMessagesLine item={item} forceOpen={forceOpen} />;
  const first = item.rows[0]!;
  const withBot = state.bots.find((bot) => bot.id === item.withBotId);
  const name = currentDogName(state.bots, item.withBotId, first.withName);
  const wording = exchangeWording(item);
  const target = item.target;
  const group = target.kind === "group" ? state.groups.find((candidate) => candidate.id === target.groupId) : undefined;
  const readOnly = target.kind === "group" && (!group || group.dm);
  const members = group?.memberIds.map((id) => currentDogName(state.bots, id, "")) ?? [];
  const [one, two] = members.length === 2 ? members : [name, name];
  const label = readOnly ? t("chat.exchange.open", { first: one, second: two }) : t("chat.openConversationWith", { name });
  const preview = foldedPreview(item);
  const open = () => {
    if (target.kind === "dog") openNotificationTarget(dispatch, target, state);
    else if (readOnly) openExchange(target.groupId);
    else dispatch({ type: "select", id: target.groupId });
  };
  return (
    <QuietLine onClick={open} label={preview ? `${label}: ${preview}` : label} title={preview ? `${label}: ${preview}` : label}>
      <span data-exchange-label>{t(wording.key, { count: wording.count })}</span>
      <BotAvatar
        bot={withBot ?? { name, color: first.withColor }}
        state="happy"
        size={QUIET_FACE_SIZE}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span data-exchange-name className="min-w-0 truncate">{name}</span>
      {preview && <span data-exchange-preview className="min-w-0 max-w-[20rem] truncate text-ink-tertiary">· {preview}</span>}
    </QuietLine>
  );
});

export function RoutineCreatedLine({
  name,
  onOpen,
  trailing,
}: {
  name: string;
  onOpen?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <QuietLine
      kind="routine"
      onClick={onOpen}
      label={onOpen ? t("chat.routine.open", { name }) : undefined}
      title={onOpen ? t("chat.routine.open", { name }) : undefined}
      after={trailing}
    >
      <span>{t("chat.routine.created")}</span>
      <Timer size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
    </QuietLine>
  );
}
