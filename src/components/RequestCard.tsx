import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type RequestTone = "muted" | "success" | "danger" | "live";

const TONE: Record<RequestTone, string> = {
  muted: "bg-control text-ink-secondary",
  success: "bg-success/15 text-success",
  danger: "bg-danger/15 text-danger",
  live: "bg-success/15 text-success",
};

export const REQUEST_PRIMARY =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app transition-colors hover:bg-ink/80 active:bg-ink/70 group-hover/request:bg-ink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 disabled:opacity-50 motion-reduce:transition-none";

export const REQUEST_SECONDARY =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-ink ring-[0.5px] ring-ink/20 transition-colors hover:bg-control hover:ring-ink/30 active:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 motion-reduce:transition-none";

export const REQUEST_QUIET =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-ink-secondary transition-colors hover:bg-control hover:text-ink active:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 motion-reduce:transition-none";

export function RequestStatus({ tone, leading, children }: { tone: RequestTone; leading?: ReactNode; children: ReactNode }) {
  return (
    <span data-request-status={tone} className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium", TONE[tone])}>
      {tone === "live" && <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />}
      {leading}
      {children}
    </span>
  );
}

export function RequestCard({
  label,
  data,
  media,
  title,
  subtitle,
  trailing,
  active,
  onActivate,
  children,
}: {
  label: string;
  data: Record<`data-${string}`, string>;
  media: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  active: boolean;
  onActivate?: () => void;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} {...data} className="flex w-full justify-start">
      <div
        data-request-card={active ? "active" : "settled"}
        onClick={onActivate ? (event) => {
          const target = event.target as HTMLElement;
          if (event.currentTarget.contains(target) && !target.closest("button, a, input")) onActivate();
        } : undefined}
        className={cn(
          "group/request relative w-full max-w-[420px] overflow-hidden rounded-card bg-card ring-[0.5px] ring-ink/10 transition-[box-shadow] motion-reduce:transition-none",
          onActivate && "cursor-pointer hover:ring-ink/25 after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-ink/0 after:transition-colors hover:after:bg-ink/[0.04] motion-reduce:after:transition-none",
        )}
      >
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-control", active ? "text-ink" : "text-ink-tertiary")}>
            {media}
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-[14px] font-medium leading-snug", active ? "text-ink" : "text-ink-secondary")}>{title}</p>
            {subtitle && <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{subtitle}</p>}
          </div>
          {trailing}
        </div>
        {children}
      </div>
    </section>
  );
}
