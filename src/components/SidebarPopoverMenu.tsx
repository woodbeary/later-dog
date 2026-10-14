import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";

export interface SidebarMenuItem {
  key: string;
  label: string;
  subtitle?: string;
  note?: string;
  icon?: React.ReactNode;
  active?: boolean;
  attention?: boolean;
  attentionTone?: "danger" | "accent";
  disabled?: boolean;
  separatorBefore?: boolean;
  heading?: string;
  trailing?: React.ReactNode;
  action?: { label: string; icon: React.ReactNode; disabled?: boolean; onSelect: () => void };
  keepOpen?: boolean;
  submenu?: React.ReactNode | ((close: () => void) => React.ReactNode);
  onSelect: () => void;
  tourId?: string;
}

const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;

function clipEdges(node: HTMLElement): { top: number; bottom: number } {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/auto|scroll|hidden/.test(style.overflowY)) continue;
    const box = parent.getBoundingClientRect();
    return { top: box.top + (parseFloat(style.scrollPaddingTop) || 0), bottom: box.bottom - (parseFloat(style.scrollPaddingBottom) || 0) };
  }
  return { top: 0, bottom: window.innerHeight };
}

export function SidebarPopoverMenu({
  items,
  ariaLabel,
  openOnHover = false,
  placement = "above",
  portal = false,
  align = "end",
  renderTrigger,
  onOpenChange,
}: {
  placement?: "above" | "below" | "auto";
  portal?: boolean;
  align?: "start" | "end";
  items: SidebarMenuItem[];
  ariaLabel: string;
  openOnHover?: boolean;
  renderTrigger: (state: { open: boolean }) => React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [up, setUp] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  const itemKeys = items.map((item) => item.key).join("\n");
  const shownKeys = useRef(itemKeys);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const motion = useMenuMotion(open);
  const [flyout, setFlyout] = useState<string | null>(null);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFlyoutTimer = () => {
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    flyoutTimer.current = null;
  };
  const showFlyout = (key: string | null, delay: number) => {
    clearFlyoutTimer();
    if (delay === 0) return setFlyout(key);
    flyoutTimer.current = setTimeout(() => setFlyout(key), delay);
  };
  useEffect(() => clearFlyoutTimer, []);
  useEffect(() => {
    if (!open) setFlyout(null);
  }, [open]);
  const hasSubmenu = items.some((item) => item.submenu);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const hoverOpen = () => {
    if (!openOnHover || pinned) return;
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    if (!openOnHover || pinned) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const close = () => {
    if (portal && menuRef.current?.contains(document.activeElement)) rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    clearTimers();
    setPinned(false);
    setOpen(false);
  };

  const dismissRef = useRef({ contains: (target: unknown) => target instanceof Node && Boolean(rootRef.current?.contains(target) || menuRef.current?.contains(target)) });
  usePopoverDismiss(open, dismissRef, close);

  useLayoutEffect(() => {
    if (!portal || !open) return;
    const place = () => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;
      const box = root.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const above = placement === "above" || (placement === "auto" && window.innerHeight - box.bottom < height + 8 && box.top > window.innerHeight - box.bottom);
      setPosition({
        left: Math.max(8, Math.min(align === "start" ? box.left : box.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(above ? box.top - height - 4 : box.bottom + 4, window.innerHeight - height - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, itemKeys, open, placement, portal]);

  useLayoutEffect(() => openChange.current?.(open), [open]);
  useEffect(() => {
    if (portal && open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, portal]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (portal || placement !== "auto" || !open || !root || !menu) return;
    const box = root.getBoundingClientRect();
    const edges = clipEdges(root);
    const below = edges.bottom - box.bottom;
    setUp(below < menu.offsetHeight + 8 && box.top - edges.top > below);
  }, [open, placement, portal]);
  useEffect(() => {
    const changed = shownKeys.current !== itemKeys;
    shownKeys.current = itemKeys;
    if (!changed || !open) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [itemKeys, open]);

  const menu = motion.shown ? (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={ariaLabel}
      {...motion.exitProps}
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      style={portal ? position : undefined}
      className={cn(
        hasSubmenu ? "overflow-visible" : "overflow-hidden",
        "rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50",
        portal ? "fixed z-[100] w-52 max-w-[calc(100vw-1rem)]" : "absolute z-40",
        !portal && (placement === "below"
          ? "top-full right-0 mt-1 w-72 max-w-[calc(100vw-2rem)]"
          : placement === "auto"
            ? cn("w-52", up ? "bottom-full mb-1" : "top-full mt-1", align === "start" ? "left-0" : "right-0")
            : "bottom-full left-0 right-0 mb-1"),
        motion.className,
      )}
    >
      {items.map((item) => (
        <div
          key={item.key}
          className="group relative"
          onPointerEnter={() => { if (hasSubmenu) showFlyout(item.submenu ? item.key : null, item.submenu ? OPEN_DELAY_MS : CLOSE_DELAY_MS); }}
          onPointerLeave={() => { if (item.submenu) showFlyout(null, CLOSE_DELAY_MS); }}
        >
          {item.separatorBefore && <div className="my-1.5 h-px bg-hairline/50" />}
          {item.heading && <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{item.heading}</div>}
          <button
            type="button"
            role="menuitem"
            data-tour={item.tourId}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? flyout === item.key : undefined}
            onClick={() => {
              if (item.submenu) return showFlyout(flyout === item.key ? null : item.key, 0);
              item.onSelect();
              if (!item.keepOpen) close();
            }}
            onKeyDown={(event) => {
              if (!item.submenu) return;
              if (event.key === "ArrowRight") {
                event.preventDefault();
                showFlyout(item.key, 0);
                const wrapper = event.currentTarget.parentElement;
                setTimeout(() => wrapper?.querySelector<HTMLElement>("[data-menu-flyout] [role=\"menuitem\"]")?.focus(), 0);
              }
              if (event.key === "ArrowLeft") showFlyout(null, 0);
            }}
            className={cn(
              "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] disabled:opacity-60",
              item.action && "pr-12",
              item.active ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
            )}
          >
            {item.icon && (
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center",
                  item.active ? "text-accent" : "text-ink-secondary",
                )}
              >
                {item.icon}
              </span>
            )}
            {item.subtitle || item.note ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                {item.subtitle && <span className="truncate text-[12px] text-ink-secondary">{item.subtitle}</span>}
                {item.note && <span className="text-[11.5px] leading-snug text-ink-tertiary">{item.note}</span>}
              </span>
            ) : (
              <span className="flex-1 truncate">{item.label}</span>
            )}
            {item.trailing}
            {item.submenu && <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
            {item.attention && (
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  item.attentionTone === "accent" ? "bg-accent" : "bg-danger",
                )}
              />
            )}
          </button>
          {item.submenu && flyout === item.key && (
            <div
              data-menu-flyout
              role="menu"
              aria-label={item.label}
              onPointerEnter={clearFlyoutTimer}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft") return;
                event.preventDefault();
                showFlyout(null, 0);
                event.currentTarget.parentElement?.querySelector<HTMLElement>(":scope > button")?.focus();
              }}
              className="absolute bottom-0 left-full z-50 pl-1.5"
            >
              <div className="overflow-hidden rounded-xl border border-hairline/50 bg-menu shadow-2xl shadow-black/50">{typeof item.submenu === "function" ? item.submenu(close) : item.submenu}</div>
            </div>
          )}
          {item.action && <button type="button" role="menuitem" aria-label={item.action.label} title={item.action.label}
            disabled={item.action.disabled} onClick={() => { item.action?.onSelect(); close(); }}
            className="absolute bottom-1 right-2 flex size-8 items-center justify-center rounded-lg text-ink-secondary opacity-0 hover:bg-control focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100 disabled:opacity-40">
            {item.action.icon}
          </button>}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      onFocus={() => openOnHover && setOpen(true)}
      onBlur={(event) => {
        if (pinned) return;
        if (!event.relatedTarget || (!rootRef.current?.contains(event.relatedTarget as Node) && !menuRef.current?.contains(event.relatedTarget as Node))) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          clearTimers();
          if (open && (pinned || !openOnHover)) close();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className="w-full"
      >
        {renderTrigger({ open })}
      </button>

      {menu && (portal ? createPortal(menu, document.body) : menu)}
    </div>
  );
}
