import { useCallback, useEffect, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { t } from "@/lib/i18n";

export interface UnreadSpan {
  top: number;
  bottom: number;
}

export interface UnreadsOutOfView {
  above: number;
  below: number;
}

export function unreadsOutOfView(rows: readonly UnreadSpan[], view: UnreadSpan): UnreadsOutOfView {
  let above = 0;
  let below = 0;
  for (const row of rows) {
    if (row.bottom <= view.top + 1) above += 1;
    else if (row.top >= view.bottom - 1) below += 1;
  }
  return { above, below };
}

function insetOf(frame: HTMLElement | null, edge: "top" | "bottom"): number {
  if (!frame) return 0;
  return parseFloat(getComputedStyle(frame).getPropertyValue(`--glass-${edge}`)) || 0;
}

function measure(sidebar: HTMLElement | null) {
  const scroller = sidebar?.querySelector<HTMLElement>("[data-sidebar-scroller]");
  if (!scroller) return null;
  const frame = scroller.closest<HTMLElement>("[data-glass-frame]");
  const box = scroller.getBoundingClientRect();
  const view = { top: box.top + insetOf(frame, "top"), bottom: box.bottom - insetOf(frame, "bottom") };
  const rows = [...scroller.querySelectorAll<HTMLElement>("[data-sidebar-unread]")];
  return { scroller, view, rows };
}

export function MoreUnreadsPills({ sidebarRef, watchKey }: { sidebarRef: RefObject<HTMLElement | null>; watchKey: string }) {
  const [counts, setCounts] = useState<UnreadsOutOfView>({ above: 0, below: 0 });

  const update = useCallback(() => {
    const found = measure(sidebarRef.current);
    if (!found) return setCounts({ above: 0, below: 0 });
    const next = unreadsOutOfView(found.rows.map((row) => row.getBoundingClientRect()), found.view);
    setCounts((current) => current.above === next.above && current.below === next.below ? current : next);
  }, [sidebarRef]);

  useEffect(() => {
    const scroller = sidebarRef.current?.querySelector<HTMLElement>("[data-sidebar-scroller]");
    update();
    if (!scroller) return;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resize?.observe(scroller);
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      resize?.disconnect();
      scroller.removeEventListener("scroll", update);
    };
  }, [sidebarRef, update, watchKey]);

  const jump = (direction: "above" | "below") => {
    const found = measure(sidebarRef.current);
    if (!found) return;
    const spans = found.rows.map((row) => ({ row, box: row.getBoundingClientRect() }));
    const target = direction === "above"
      ? spans.filter(({ box }) => box.bottom <= found.view.top + 1).at(-1)
      : spans.find(({ box }) => box.top >= found.view.bottom - 1);
    target?.row.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const pill = (direction: "above" | "below", count: number) => (
    <button
      type="button"
      data-more-unreads={direction}
      aria-label={direction === "above" ? t("sidebar.unreads.above", { count }) : t("sidebar.unreads.below", { count })}
      onClick={() => jump(direction)}
      className="pointer-events-auto flex items-center gap-1 rounded-full border border-hairline/50 bg-card px-3 py-1 text-[12px] font-medium text-ink shadow-lg hover:bg-raised"
    >
      {direction === "above" ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      {t("sidebar.unreads.count", { count })}
    </button>
  );

  if (counts.above === 0 && counts.below === 0) return null;
  return (
    <>
      {counts.above > 0 && <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center" style={{ top: "calc(var(--glass-top, 0px) + 6px)" }}>{pill("above", counts.above)}</div>}
      {counts.below > 0 && <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center" style={{ bottom: "calc(var(--glass-bottom, 0px) + 6px)" }}>{pill("below", counts.below)}</div>}
    </>
  );
}
