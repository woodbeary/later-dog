import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { isUnread, type SeenRow } from "./unread-boundary";

export type UnreadPosition = "above" | "visible" | "below" | "none";

export interface Span {
  top: number;
  bottom: number;
}

export function unreadCount(rows: readonly SeenRow[], since: number | null): number {
  return since === null ? 0 : rows.filter((row) => isUnread(row, since)).length;
}

export function unreadPosition(divider: Span | null, view: Span): UnreadPosition {
  if (!divider) return "none";
  if (divider.bottom <= view.top) return "above";
  if (divider.top >= view.bottom) return "below";
  return "visible";
}

export function unreadBelowCount(rows: readonly (SeenRow & { id: string })[], since: number | null, firstBelowId: string | null): number {
  if (since === null || firstBelowId === null) return 0;
  const start = rows.findIndex((row) => row.id === firstBelowId);
  if (start < 0) return 0;
  return rows.slice(start).filter((row) => isUnread(row, since)).length;
}

export function dismissKey(thread: string, since: number | null): string {
  return `${thread}:${since ?? "none"}`;
}

export function useUnreadPosition(
  scrollRef: RefObject<HTMLElement | null>,
  active: boolean,
  topInset: number,
  bottomInset: number,
  watch: unknown,
): UnreadPosition {
  const [position, setPosition] = useState<UnreadPosition>("none");
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !active) return setPosition("none");
    const divider = scroller.querySelector<HTMLElement>("[data-unread-divider]");
    const box = scroller.getBoundingClientRect();
    const rect = divider?.getBoundingClientRect() ?? null;
    setPosition(unreadPosition(rect, { top: box.top + topInset, bottom: box.bottom - bottomInset }));
  }, [scrollRef, active, topInset, bottomInset]);
  useEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller || !active) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", later, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", later);
      observer?.disconnect();
    };
  }, [measure, scrollRef, active, watch]);
  return position;
}

export function useVisitUnreadCount(key: string, since: number | null, rows: readonly SeenRow[]): number {
  const held = useRef<{ key: string; since: number | null; count: number } | null>(null);
  if (held.current?.key !== key || held.current.since !== since) {
    held.current = { key, since, count: unreadCount(rows, since) };
  }
  return held.current.count;
}
