import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const MORE_BELOW_PX = 4;

const fadeBelow = (length: number) => `linear-gradient(to bottom, black calc(100% - ${length}px), transparent)`;

export function FadingScroll({ className, children, style, fade = 36, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; fade?: number }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = useCallback(() => {
    const box = outer.current;
    if (box) setMoreBelow(box.scrollHeight - box.scrollTop - box.clientHeight > MORE_BELOW_PX);
  }, []);
  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    if (outer.current) watch.observe(outer.current);
    if (inner.current) watch.observe(inner.current);
    return () => watch.disconnect();
  }, [measure]);
  return (
    <div
      ref={outer}
      onScroll={measure}
      data-more-below={moreBelow || undefined}
      className={cn("overflow-y-auto", className)}
      style={moreBelow ? { ...style, maskImage: fadeBelow(fade), WebkitMaskImage: fadeBelow(fade) } : style}
      {...rest}
    >
      <div ref={inner} className="flex flex-col">{children}</div>
    </div>
  );
}
