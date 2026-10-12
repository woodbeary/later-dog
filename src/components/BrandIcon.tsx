import type { HTMLAttributes } from "react";

import { BRAND_INK, BRAND_TILE, brandMark, markColor } from "@/lib/brand-icons";
import { cn } from "@/lib/cn";

const MARK_SCALE = 0.55;
const CORNER_SCALE = 0.3;

export function BrandIcon({ brand, name, size = 40, decorative = false, className }: {
  brand: string;
  name: string;
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  const mark = brandMark(brand);
  const markSize = Math.round(size * MARK_SCALE);
  const label: HTMLAttributes<HTMLSpanElement> = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name };
  return (
    <span
      data-brand-icon={brand}
      {...label}
      className={cn("inline-flex shrink-0 items-center justify-center ring-1 ring-inset ring-black/10 forced-color-adjust-none", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * CORNER_SCALE), backgroundColor: BRAND_TILE }}
    >
      {mark ? (
        <svg viewBox="0 0 24 24" width={markSize} height={markSize} fill={markColor(mark)} aria-hidden="true" focusable="false">
          <path d={mark.path} />
        </svg>
      ) : (
        <span aria-hidden="true" className="font-semibold leading-none" style={{ color: BRAND_INK, fontSize: Math.round(size * 0.4) }}>
          {name.trim().slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}
