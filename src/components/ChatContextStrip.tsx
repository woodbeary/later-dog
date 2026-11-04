import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { chatContextFigure, type ChatContextLevel, type ChatContextReading } from "@/lib/chat-context";

const FILL: Record<ChatContextLevel, string> = { ok: "bg-ink", near: "bg-warning", over: "bg-danger" };
const FIGURE: Record<ChatContextLevel, string> = { ok: "text-ink-secondary", near: "text-warning", over: "text-danger" };

export function ChatContextStrip({ reading }: { reading: ChatContextReading }) {
  const figure = chatContextFigure(reading);
  return (
    <div data-chat-context={reading.percent === null ? "tokens" : Math.round(reading.percent)} className="flex shrink-0 flex-col gap-2 px-3.5 pb-3 pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-ink">{t("model.context.title")}</span>
        <span className={cn("truncate text-[12px] tabular-nums", FIGURE[reading.level])}>{figure}</span>
      </div>
      {reading.percent !== null && (
        <span
          role="meter"
          aria-label={t("model.context.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(reading.percent)}
          aria-valuetext={figure}
          className="block h-1 w-full overflow-hidden rounded-full bg-control"
        >
          <span className={cn("block h-full rounded-full", FILL[reading.level])} style={{ width: `${Math.max(2, reading.percent)}%` }} />
        </span>
      )}
    </div>
  );
}
