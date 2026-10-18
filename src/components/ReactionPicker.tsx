import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Smile, SmilePlus } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { QUICK_REACTIONS, searchEmoji } from "@/lib/reactions";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useMenuMotion } from "./MenuMotion";
import { messageActionClass } from "./MessageActions";

const EDGE = 8;

export function reactionButtonLabel(emoji: string, reacted: boolean): string {
  return reacted ? t("chat.reaction.remove", { emoji }) : t("chat.reaction.add", { emoji });
}

export function ReactionPicker({
  reacted,
  onReact,
  onOpenChange,
  align = "start",
}: {
  reacted: readonly string[];
  onReact: (emoji: string) => void;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "end";
}) {
  const [open, setOpenState] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const motion = useMenuMotion(open);
  const found = useMemo(() => (searching ? searchEmoji(query) : []), [searching, query]);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
    if (!next) {
      setSearching(false);
      setQuery("");
    }
  };
  const close = () => {
    if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setOpen(false);
  };
  const pick = (emoji: string) => {
    onReact(emoji);
    close();
  };

  const dismissRef = useRef({
    contains: (target: unknown) => target instanceof Node && Boolean(triggerRef.current?.contains(target) || panelRef.current?.contains(target)),
  });
  usePopoverDismiss(open, dismissRef, close);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const box = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const above = box.top - height - 4 >= EDGE || window.innerHeight - box.bottom < height + EDGE;
      setPosition({
        left: Math.max(EDGE, Math.min(align === "start" ? box.left : box.right - width, window.innerWidth - width - EDGE)),
        top: Math.max(EDGE, Math.min(above ? box.top - height - 4 : box.bottom + 4, window.innerHeight - height - EDGE)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, searching, found.length, align]);

  useLayoutEffect(() => {
    if (!open) return;
    const target = searching
      ? panelRef.current?.querySelector<HTMLElement>("input")
      : panelRef.current?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [open, searching]);

  const emojiButton = (emoji: string, size: "quick" | "grid") => {
    const selected = reacted.includes(emoji);
    return (
      <button
        key={emoji}
        type="button"
        onClick={() => pick(emoji)}
        aria-label={reactionButtonLabel(emoji, selected)}
        aria-pressed={selected}
        title={reactionButtonLabel(emoji, selected)}
        className={cn(
          "flex items-center justify-center rounded-full transition-transform hover:scale-110 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          size === "quick" ? "size-9 text-[22px]" : "size-8 text-[19px]",
          selected && "bg-raised",
        )}
      >
        <span aria-hidden="true">{emoji}</span>
      </button>
    );
  };

  const panel = motion.shown ? (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={t("chat.reaction.picker")}
      {...motion.exitProps}
      style={position}
      data-testid="reaction-picker"
      className={cn(
        "fixed z-[100] max-w-[calc(100vw-1rem)] rounded-2xl border border-hairline/50 bg-menu p-1.5 shadow-2xl shadow-black/50",
        motion.className,
      )}
    >
      {searching ? (
        <div className="flex w-[296px] flex-col gap-1.5">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && found[0]) {
                event.preventDefault();
                pick(found[0].emoji);
              }
            }}
            placeholder={t("chat.reaction.search")}
            aria-label={t("chat.reaction.search")}
            className="h-8 w-full rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          {found.length ? (
            <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto" role="group" aria-label={t("chat.reaction.picker")}>
              {found.map((entry) => emojiButton(entry.emoji, "grid"))}
            </div>
          ) : (
            <p className="px-1 py-3 text-center text-[13px] text-ink-secondary">{t("chat.reaction.none")}</p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          {QUICK_REACTIONS.map((emoji) => emojiButton(emoji, "quick"))}
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label={t("chat.reaction.more")}
            title={t("chat.reaction.more")}
            className="flex size-9 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <SmilePlus size={18} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={t("chat.reaction.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={t("chat.reaction.open")}
        className={cn(messageActionClass, open && "bg-raised text-ink")}
      >
        <Smile size={14} aria-hidden="true" />
      </button>
      {panel && createPortal(panel, document.body)}
    </>
  );
}
