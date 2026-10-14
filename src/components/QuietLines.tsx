import { memo, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, MessagesSquare, Timer } from "lucide-react";
import { openThread, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { currentDogName } from "@/lib/dog-refs";
import { openExchange } from "@/lib/exchange-view";
import { exchangeWording, foldedPreview, openedExchange, type ExchangeItem } from "@/lib/quiet-lines";
import { BotAvatar } from "./Avatar";
import { ThreadChip } from "./ThreadChip";

export const QUIET_FACE_SIZE = 14;

export function QuietLine({
  children,
  onClick,
  title,
  label,
  className,
  after,
  kind,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  label?: string;
  className?: string;
  after?: ReactNode;
  kind?: string;
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

function OpenedThreadsLine({ item, forceOpen }: { item: ExchangeItem; forceOpen: boolean }) {
  const [open, setOpen] = useState(forceOpen);
  const expanded = forceOpen || open;
  const details = useId();
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const wording = exchangeWording(item);
  return <div data-opened-threads="" className="flex min-w-0 flex-col items-center gap-1.5">
    <button type="button" aria-expanded={expanded} aria-controls={details} onClick={() => setOpen(value => !value)} className="flex h-6 max-w-full items-center gap-1.5 rounded-full border border-hairline/50 bg-control/60 px-2 text-[12px] leading-4 text-ink-secondary transition-colors hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
      <MessagesSquare size={13} aria-hidden="true" className="shrink-0" />
      <span>{t(wording.key, { count: wording.count })}</span>
      <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
    </button>
    <div id={details} hidden={!expanded} className="w-full min-w-0 max-w-[560px]">
      {expanded && <ul className="space-y-1.5 rounded-xl border border-hairline/50 bg-panel/50 p-2">{item.rows.map(row => <li key={row.message.id} data-mid={row.message.id}><ThreadChip message={row.message} /></li>)}</ul>}
    </div>
  </div>;
}

export const ExchangeLine = memo(function ExchangeLine({ item, forceOpen = false }: { item: ExchangeItem; forceOpen?: boolean }) {
  const { state, dispatch } = useStore();
  if (openedExchange(item)) return item.rows.length === 1
    ? <div data-opened-threads="" className="flex justify-center"><ThreadChip message={item.rows[0]!.message} /></div>
    : <OpenedThreadsLine item={item} forceOpen={forceOpen} />;
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
    if (target.kind === "thread") openThread(dispatch, { botId: target.botId, threadId: target.threadId }, state);
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
