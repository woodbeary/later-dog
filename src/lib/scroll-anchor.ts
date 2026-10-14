import { useEffect, type RefObject } from "react";

export const ANCHOR_EPSILON = 0.5;

export function anchorShift(previousOffset: number, nextOffset: number): number {
  const delta = nextOffset - previousOffset;
  return Math.abs(delta) < ANCHOR_EPSILON ? 0 : delta;
}

interface Anchor {
  id: string;
  offset: number;
}

export function boxOf(row: HTMLElement): DOMRect | null {
  for (const child of row.children) {
    const rect = child.getBoundingClientRect();
    if (rect.height > 0) return rect;
  }
  const rect = row.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

function findAnchor(scroller: HTMLElement): Anchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>("[data-mid]")) {
    const rect = boxOf(row);
    if (rect && rect.bottom > top) return { id: row.dataset.mid ?? "", offset: rect.top - top };
  }
  return null;
}

export function useScrollAnchor(
  scrollRef: RefObject<HTMLElement | null>,
  transcriptRef: RefObject<HTMLElement | null>,
  followingRef: RefObject<boolean>,
  active: boolean,
): void {
  useEffect(() => {
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!scroller || !transcript || !active) return;
    let anchor: Anchor | null = null;
    const remember = () => {
      anchor = followingRef.current ? null : findAnchor(scroller);
    };
    const hold = () => {
      if (followingRef.current || !anchor) return;
      const row = [...scroller.querySelectorAll<HTMLElement>("[data-mid]")].find((candidate) => candidate.dataset.mid === anchor!.id);
      if (!row) {
        remember();
        return;
      }
      const box = boxOf(row);
      if (!box) return;
      const offset = box.top - scroller.getBoundingClientRect().top;
      const shift = anchorShift(anchor.offset, offset);
      if (shift !== 0) scroller.scrollTop += shift;
    };
    remember();
    scroller.addEventListener("scroll", remember, { passive: true });
    const observer = new ResizeObserver(hold);
    observer.observe(transcript);
    return () => {
      scroller.removeEventListener("scroll", remember);
      observer.disconnect();
    };
  }, [scrollRef, transcriptRef, followingRef, active]);
}
