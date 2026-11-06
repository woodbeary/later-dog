import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const MORE_BELOW_PX = 4;

export function FadingScroll({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
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
      className={cn("overflow-y-auto", moreBelow && "[mask-image:linear-gradient(to_bottom,black_calc(100%-36px),transparent)]", className)}
      {...rest}
    >
      <div ref={inner} className="flex flex-col">{children}</div>
    </div>
  );
}
