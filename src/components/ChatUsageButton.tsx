import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatContextReading } from "@/lib/chat-context";
import { useContextBreakdown } from "@/lib/context-breakdown";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { AccountRest } from "./AccountCharge";
import { ChatContextBreakdown, contextRowShown } from "./ChatContextBreakdown";
import { useMenuMotion } from "./MenuMotion";
import { AccountUsage, type PlanProvider } from "./PlanUsage";

export const CHAT_USAGE_WIDTH = 300;

export interface ChatUsageButtonProps {
  mark: ReactNode;
  title: string;
  reading: ChatContextReading | null;
  threadId?: string;
  accountName: string | null;
  provider: PlanProvider | undefined;
  resting: AccountRest | undefined;
  now: number;
  onOpen(): void;
  onSeeAll(): void;
}

export function ChatUsageButton({ mark, title, reading, threadId, accountName, provider, resting, now, onOpen, onSeeAll }: ChatUsageButtonProps) {
  const [open, setOpen] = useState(false);
  const breakdown = useContextBreakdown(threadId, open);
  const contextShown = contextRowShown(reading, breakdown);
  const rootRef = useRef<HTMLDivElement>(null);
  const motion = useMenuMotion(open);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-chat-usage
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("model.usage.title")}
        title={title}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
        className={cn("flex size-8 items-center justify-center rounded-full hover:bg-control", open && "bg-control")}
      >
        {mark}
      </button>
      {motion.shown && (
        <div
          role="dialog"
          data-chat-usage-panel
          aria-label={t("model.usage.title")}
          {...motion.exitProps}
          style={{ width: CHAT_USAGE_WIDTH }}
          className={cn("absolute bottom-full left-0 z-30 mb-2 flex max-w-[calc(100vw-2rem)] origin-bottom-left flex-col overflow-hidden rounded-menu border border-hairline/50 bg-card shadow-popover", motion.className)}
        >
          {contextShown && <ChatContextBreakdown reading={reading} view={breakdown} now={now} />}
          {(provider || resting) && (
            <section data-chat-usage-account className={cn("flex flex-col gap-2.5 px-3.5 pb-3 pt-3", contextShown && "border-t border-hairline/40")}>
              {accountName && <p className="truncate text-[13px] font-medium text-ink">{accountName}</p>}
              <AccountUsage provider={provider} now={now} resting={resting} />
            </section>
          )}
          <button
            type="button"
            data-chat-usage-all
            onClick={() => {
              setOpen(false);
              onSeeAll();
            }}
            className="flex items-center justify-between gap-2 border-t border-hairline/40 px-3.5 py-2.5 text-left text-[13px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
          >
            {t("settings.section.usage")}
            <ChevronRight size={14} aria-hidden="true" className="text-ink-tertiary" />
          </button>
        </div>
      )}
    </div>
  );
}
