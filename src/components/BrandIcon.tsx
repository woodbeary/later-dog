import { useState, type HTMLAttributes, type ReactNode } from "react";

import { appIconUrl } from "@/lib/app-icons";
import { BRAND_INK, BRAND_TILE, brandMark, markColor } from "@/lib/brand-icons";
import { cn } from "@/lib/cn";

const MARK_SCALE = 0.55;
const CORNER_SCALE = 0.3;

function AppIcon({ src, size, fallback }: { src: string; size: number; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      className="rounded-[22%] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

export function BrandIcon({ brand, name, domain, size = 40, decorative = false, className }: {
  brand: string;
  name: string;
  domain?: string;
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  const mark = brandMark(brand);
  const icon = mark ? undefined : appIconUrl(domain);
  const markSize = Math.round(size * MARK_SCALE);
  const label: HTMLAttributes<HTMLSpanElement> = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name };
  const initial = (
    <span aria-hidden="true" className="font-semibold leading-none" style={{ color: BRAND_INK, fontSize: Math.round(size * 0.4) }}>
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
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
      ) : icon ? (
        <AppIcon key={icon} src={icon} size={markSize} fallback={initial} />
      ) : initial}
    </span>
  );
}
