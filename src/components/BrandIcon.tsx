// A connector's brand mark (lib/brand-icons.ts) on its tile. One rule for
// every brand and every skin: the mark in its brand colour (or its black
// one-colour form where that colour would vanish) on a white rounded square
// with a hairline edge, so it reads the same on light and dark surfaces. A
// brand with no mark gets the same tile with its initial.
import type { HTMLAttributes } from "react";

import { BRAND_INK, BRAND_TILE, brandMark, markColor } from "@/lib/brand-icons";
import { cn } from "@/lib/cn";

/** How much of the tile the mark spans. Simple Icons marks fill their 24×24 box. */
const MARK_SCALE = 0.55;
/** Corner radius as a share of the tile: 12px on a 40px tile, Tailwind's rounded-xl. */
const CORNER_SCALE = 0.3;

export function BrandIcon({ brand, name, size = 40, decorative = false, className }: {
  /** The brand's key in BRAND_MARKS: a connector's id, or a toolkit slug. */
  brand: string;
  /** The brand's name: the tile's accessible name, and its letter when no mark is known. */
  name: string;
  /** The tile's edge, in CSS pixels. */
  size?: number;
  /** The name already sits beside the tile, so assistive technology skips it. */
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
      // a picture of the brand, like a bitmap logo: forced colours leave it as drawn
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
