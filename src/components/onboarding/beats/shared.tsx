import { useRef, type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { DogMotion, DogState } from "@/lib/mascot";

export interface BeatProps {
  onNext: () => void;
  onSkip: () => void;
  setMascot: (state: DogState) => void;
  bump: (motion: Exclude<DogMotion, "none">) => void;
}

export const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none";

export function staggerIndex(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

export const PRIMARY_SETTLE_MS = 600;
export const PRIMARY_REPEAT_MS = 800;

export function PrimaryButton({
  children,
  className,
  onClick,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const shownAt = useRef(Date.now());
  const lastClick = useRef(0);
  return (
    <button
      data-primary=""
      {...rest}
      onClick={(event) => {
        const now = Date.now();
        if (now - shownAt.current < PRIMARY_SETTLE_MS || now - lastClick.current < PRIMARY_REPEAT_MS) return;
        lastClick.current = now;
        onClick?.(event);
      }}
      className={cn(
        "w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cn("text-[12px] text-ink-secondary transition-colors hover:text-ink", className)}
    >
      {children}
    </button>
  );
}

