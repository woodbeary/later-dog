import { ArrowDown, ArrowUp, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { dogTint } from "@/lib/mascot";

export const newMessagesLabel = (count: number): string =>
  count === 1 ? t("chat.newBelowOne") : t("chat.newBelowMany", { count });

export function NewMessagesPill({
  direction,
  count,
  onJump,
  onDismiss,
  style,
  className,
  tint,
}: {
  direction: "up" | "down";
  count: number;
  onJump: () => void;
  onDismiss?: () => void;
  style?: React.CSSProperties;
  className?: string;
  tint?: string;
}) {
  const Arrow = direction === "up" ? ArrowUp : ArrowDown;
  const words = newMessagesLabel(count);
  return (
    <div
      data-new-messages-pill={direction}
      data-count={count}
      data-dog-tint={dogTint(tint)}
      style={style}
      className={cn(
        "new-messages-pill absolute left-1/2 z-10 flex -translate-x-1/2 items-center rounded-full bg-bubble-user text-[12.5px] font-medium text-white shadow-lg",
        className,
      )}
    >
      <button
        type="button"
        onClick={onJump}
        aria-label={direction === "up" ? t("chat.newAboveAria", { label: words }) : t("chat.newBelowAria", { label: words })}
        className={cn("flex items-center gap-1.5 rounded-full py-1.5 pl-3 transition-colors hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2", onDismiss ? "pr-1.5" : "pr-3")}
      >
        <Arrow size={13} aria-hidden="true" />
        <span>{words}</span>
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.newDismiss")}
          className="mr-1 flex size-6 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
