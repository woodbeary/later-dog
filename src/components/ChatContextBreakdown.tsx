import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { chatContextFigure, chatContextReading, contextPercentWords, type ChatContextLevel, type ChatContextReading } from "@/lib/chat-context";
import { partLabel, partShareWords, partTokensWords, STALE_AFTER_MS, type ContextBreakdownView } from "@/lib/context-breakdown";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { formatTokens } from "@/lib/usage";
import { breakdownIsStale, contextRows, differsFrom, type ChatNow, type ContextBreakdown, type ContextRow } from "../../shared/context-breakdown";
import { ChatContextStrip } from "./ChatContextStrip";

const FIGURE: Record<ChatContextLevel, string> = { ok: "text-ink-secondary", near: "text-warning", over: "text-danger" };
const INK_STEPS = ["bg-ink", "bg-ink/70", "bg-ink/50", "bg-ink/35", "bg-ink/25", "bg-ink/20", "bg-ink/15"];
const RESERVE_INK = "bg-ink/10";

export interface ChatContextBreakdownProps {
  reading: ChatContextReading | null;
  view: ContextBreakdownView | null;
  now: number;
  chat?: ChatNow;
}

export function shownBreakdown(view: ContextBreakdownView | null): ContextBreakdown | null {
  const breakdown = view?.state === "ready" || view?.state === "loading" ? view.breakdown : null;
  return breakdown && breakdown.total > 0 ? breakdown : null;
}

export function contextRowShown(reading: ChatContextReading | null, view: ContextBreakdownView | null): boolean {
  return Boolean(shownBreakdown(view) || reading || view?.state === "nothing");
}

export function ChatContextBreakdown({ reading, view, now, chat }: ChatContextBreakdownProps) {
  const breakdown = shownBreakdown(view);
  if (breakdown) return <BreakdownRow breakdown={breakdown} current={reading} chat={chat} now={now} />;
  if (reading) return <ChatContextStrip reading={reading} />;
  if (view?.state === "nothing") {
    return (
      <div data-chat-context="nothing" className="flex shrink-0 items-baseline justify-between gap-3 px-3.5 pb-3 pt-3">
        <span className="text-[13px] font-medium text-ink">{t("model.context.title")}</span>
        <span className="truncate text-[12px] text-ink-tertiary">{t("model.context.afterFirstReply")}</span>
      </div>
    );
  }
  return null;
}

function figureOf(breakdown: ContextBreakdown, reading: ChatContextReading): string {
  if (breakdown.source === "engine" || reading.window === null || reading.percent === null) return chatContextFigure(reading);
  return t("model.context.figureAbout", { used: formatTokens(reading.tokens), window: formatTokens(reading.window), percent: contextPercentWords(reading.percent) });
}

function BreakdownRow({ breakdown, current, chat, now }: { breakdown: ContextBreakdown; current: ChatContextReading | null; chat: ChatNow | undefined; now: number }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const reading = current ?? chatContextReading({ tokens: breakdown.total, window: breakdown.window })!;
  const outdated = breakdownIsStale(breakdown, { ...chat, tokens: current?.tokens });
  const figure = figureOf(breakdown, reading);
  const estimate = breakdown.source === "estimate";
  const rows = contextRows(breakdown);
  const partsAbout = estimate || (!outdated && differsFrom(rows.usedTokens, reading.tokens));
  const hasParts = rows.used.length > 0;
  const reserve = rows.room.find((row) => row.id === "reserve");
  const old = now - breakdown.at > STALE_AFTER_MS;
  const asOf = <p data-chat-context-as-of className="text-[11px] text-ink-tertiary">{t("model.context.asOf", { ago: relativeTime(breakdown.at, now) })}</p>;
  return (
    <div data-chat-context={Math.round(reading.percent ?? 0)} data-chat-context-source={breakdown.source} data-chat-context-stale={outdated ? "" : undefined} className="flex shrink-0 flex-col gap-2 px-3.5 pb-3 pt-3">
      <button
        type="button"
        data-chat-context-toggle
        aria-expanded={hasParts ? open : undefined}
        aria-controls={hasParts ? listId : undefined}
        aria-label={hasParts ? `${t("model.context.showParts")}, ${figure}` : undefined}
        disabled={!hasParts}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex items-baseline justify-between gap-3 rounded-md px-1 text-left enabled:hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="text-[13px] font-medium text-ink">{t("model.context.title")}</span>
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn("truncate text-[12px] tabular-nums", FIGURE[reading.level])}>{figure}</span>
          {hasParts && <ChevronDown size={13} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform motion-reduce:transition-none", open && "rotate-180")} />}
        </span>
      </button>
      <span
        role="meter"
        aria-label={t("model.context.title")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(reading.percent ?? 0)}
        aria-valuetext={figure}
        data-chat-context-bar
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-control"
      >
        {hasParts && !outdated
          ? rows.used.map((row, index) => <Segment key={row.id} row={row} ink={INK_STEPS[Math.min(index, INK_STEPS.length - 1)]!} />)
          : <span className="block h-full bg-ink" style={{ width: `${Math.max(2, reading.percent ?? 0)}%` }} />}
        {hasParts && !outdated && reserve && <span data-chat-context-segment="reserve" className={cn("ml-auto block h-full", RESERVE_INK)} style={{ width: `${reserve.percent}%` }} />}
      </span>
      {outdated && asOf}
      {open && hasParts && (
        <div id={listId} data-chat-context-parts className="flex flex-col gap-1 pt-1">
          <ul className="flex flex-col gap-1">
            {[...rows.used, ...rows.room].map((row) => (
              <PartLine key={row.id} label={partLabel(row.id, breakdown.source)} tokens={partTokensWords(row.tokens, partsAbout)} share={partShareWords(row.percent)} />
            ))}
          </ul>
          {rows.notLoaded > 0 && (
            <ul className="mt-1 border-t border-hairline/40 pt-1.5">
              <PartLine label={t("model.context.notLoaded")} tokens={partTokensWords(rows.notLoaded, partsAbout)} share="—" muted />
            </ul>
          )}
          {old && !outdated && asOf}
        </div>
      )}
    </div>
  );
}

function Segment({ row, ink }: { row: ContextRow; ink: string }) {
  return <span data-chat-context-segment={row.id} className={cn("block h-full border-r border-card last:border-r-0", ink)} style={{ width: `${row.percent}%` }} />;
}

function PartLine({ label, tokens, share, muted = false }: { label: string; tokens: string; share: string; muted?: boolean }) {
  return (
    <li data-chat-context-part className={cn("flex items-baseline gap-2 text-[12px]", muted ? "text-ink-tertiary" : "text-ink-secondary")}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{tokens}</span>
      <span className="w-11 shrink-0 text-right tabular-nums">{share}</span>
    </li>
  );
}
