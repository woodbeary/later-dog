import { Paperclip, Plug, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useMenuMotion } from "./MenuMotion";

export function ComposerPlusMenu({ onAttach, onConnectors }: {
  onAttach: () => void;
  onConnectors?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const row = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-45 disabled:hover:bg-transparent";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        data-composer-plus
        onClick={() => setOpen((was) => !was)}
        aria-label={t("composer.plus")}
        title={t("composer.plus")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink", open && "bg-control text-ink")}
      >
        <Plus size={18} className={cn("transition-transform", open && "rotate-45")} />
      </button>
      {motion.shown && (
        <div
          role="menu"
          data-composer-plus-menu
          {...motion.exitProps}
          className={cn("absolute bottom-full left-0 z-30 mb-2 w-60 rounded-menu origin-bottom-left border border-hairline/50 bg-card p-1 shadow-popover", motion.className)}
        >
          <button type="button" role="menuitem" className={row} onClick={() => { setOpen(false); onAttach(); }}>
            <Paperclip size={16} className="shrink-0 text-ink-secondary" />
            {t("composer.attach")}
          </button>
          {onConnectors && (
            <button type="button" role="menuitem" className={row} onClick={() => { setOpen(false); onConnectors(); }}>
              <Plug size={16} className="shrink-0 text-ink-secondary" />
              {t("composer.connectors")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
