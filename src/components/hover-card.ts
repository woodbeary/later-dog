import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";

export const HOVER_OPEN_MS = 80;
export const HOVER_CLOSE_MS = 220;

export function useHoverCard() {
  const [id, setId] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const place = (rowId: string, element: HTMLElement) => {
    const root = rootRef.current;
    if (root) setTop(Math.max(0, element.getBoundingClientRect().top - root.getBoundingClientRect().top));
    setId(rowId);
  };
  const show = (rowId: string, element: HTMLElement, delay: number) => {
    clear();
    if (delay === 0) return place(rowId, element);
    timer.current = setTimeout(() => place(rowId, element), delay);
  };
  const hide = (delay: number) => {
    clear();
    timer.current = setTimeout(() => setId(null), delay);
  };

  return {
    id,
    top,
    rootRef,
    listRef,
    keep: clear,
    leave: () => hide(HOVER_CLOSE_MS),
    row: (rowId: string) => ({
      onPointerEnter: (event: PointerEvent<HTMLElement>) => show(rowId, event.currentTarget, HOVER_OPEN_MS),
      onPointerLeave: () => hide(HOVER_CLOSE_MS),
      onFocus: (event: FocusEvent<HTMLElement>) => show(rowId, event.currentTarget, 0),
    }),
    key: (event: KeyboardEvent<HTMLElement>, rowId: string) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        if (event.key === "ArrowLeft") return hide(0);
        const row = event.currentTarget.parentElement;
        if (row) show(rowId, row, 0);
        setTimeout(() => rootRef.current?.querySelector<HTMLElement>("[data-account-manage-usage]")?.focus(), 0);
      }
    },
  };
}
