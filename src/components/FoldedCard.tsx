import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export function FoldedCard({
  icon,
  summary,
  title,
  label,
  arriving,
  takeFocus = false,
  centered = false,
  children,
}: {
  icon: ReactNode;
  summary: ReactNode;
  title: string;
  label?: string;
  arriving: boolean;
  takeFocus?: boolean;
  centered?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const line = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  useEffect(() => {
    if (!takeFocus) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    line.current?.focus({ preventScroll: true });
  }, [takeFocus]);
  return (
    <div
      data-folded-card
      className={cn(centered ? "flex w-full flex-col items-center" : "w-full max-w-[420px]", arriving && "motion-safe:animate-msg-in")}
    >
      <button
        ref={line}
        type="button"
        data-folded-line
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={label}
        title={title}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] text-ink-secondary transition-colors duration-(--motion-micro) hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
      >
        {icon}
        {summary}
        <ChevronRight
          size={13}
          aria-hidden
          className={cn(
            "shrink-0 text-ink-tertiary transition-transform duration-(--motion-micro) ease-(--ease-out-soft) motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div id={bodyId} className={cn("mt-1.5 motion-safe:animate-msg-in", centered && "w-full max-w-[420px]")}>
          {children}
        </div>
      )}
    </div>
  );
}
