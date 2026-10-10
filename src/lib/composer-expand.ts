import { useLayoutEffect, useState, type RefObject } from "react";

export function textWraps(input: HTMLTextAreaElement): boolean {
  const style = getComputedStyle(input);
  const line = parseFloat(style.lineHeight) || 24;
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return input.scrollHeight - padding > line * 1.5;
}

export function useTextWrapped(inputRef: RefObject<HTMLTextAreaElement | null>, text: string): boolean {
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!text) setWrapped(false);
    else if (text.includes("\n") || (input && textWraps(input))) setWrapped(true);
  }, [inputRef, text]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (input.value && textWraps(input)) setWrapped(true);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef]);
  return wrapped;
}
