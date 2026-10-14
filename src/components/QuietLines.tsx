import { memo, type ReactNode } from "react";
import { Timer } from "lucide-react";
import { openThread, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { currentDogName } from "@/lib/dog-refs";
import { openExchange } from "@/lib/exchange-view";
import { exchangeWording, type ExchangeItem } from "@/lib/quiet-lines";
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

export const ExchangeLine = memo(function ExchangeLine({ item }: { item: ExchangeItem }) {
  const { state, dispatch } = useStore();
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
  const open = () => {
    if (target.kind === "thread") openThread(dispatch, { botId: target.botId, threadId: target.threadId }, state);
    else if (readOnly) openExchange(target.groupId);
    else dispatch({ type: "select", id: target.groupId });
  };
  return (
    <QuietLine onClick={open} label={label} title={label}>
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
