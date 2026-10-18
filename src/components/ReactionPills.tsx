import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { MY_REACTION, reactionSummary, type Reaction, type ReactionSummary } from "@/lib/reactions";

export function reactionPillLabel(summary: ReactionSummary, nameOf: (by: string) => string): string {
  const names = [...summary.by].sort((a, b) => Number(b === MY_REACTION) - Number(a === MY_REACTION))
    .map((by) => (by === MY_REACTION ? t("chat.reaction.you") : nameOf(by)));
  const list = new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(names);
  return t("chat.reaction.by", { names: list, emoji: summary.emoji });
}

export function ReactionPills({
  reactions,
  side,
  nameOf,
  onToggle,
}: {
  reactions: ReadonlyArray<Reaction> | undefined;
  side: "user" | "bot";
  nameOf: (by: string) => string;
  onToggle?: (emoji: string) => void;
}) {
  const summary = reactionSummary(reactions);
  if (!summary.length) return null;
  return (
    <div
      data-testid="reaction-pills"
      className={cn("relative z-[1] -mt-1.5 flex max-w-[min(42rem,78%)] flex-wrap gap-1 px-2", side === "user" ? "justify-end" : "justify-start")}
    >
      {summary.map((item) => {
        const label = reactionPillLabel(item, nameOf);
        return (
          <button
            key={item.emoji}
            type="button"
            disabled={!onToggle}
            onClick={() => onToggle?.(item.emoji)}
            aria-pressed={item.mine}
            aria-label={label}
            title={label}
            className={cn(
              "animate-pop-in flex h-6 min-w-[30px] items-center justify-center gap-1 rounded-full border-2 border-panel px-1.5 text-[13px] leading-none transition-colors disabled:cursor-default",
              item.mine ? "bg-raised-hover text-ink ring-1 ring-ink/35 hover:bg-control-hover" : "bg-card text-ink-secondary hover:bg-raised",
            )}
          >
            <span aria-hidden="true">{item.emoji}</span>
            {item.count > 1 && <span className="text-[11.5px] font-semibold tabular-nums">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
