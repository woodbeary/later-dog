import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DogAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { DogState } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";
import { positionSpotlight, type SpotlightPlacement, type SpotlightRect } from "./spotlight-position";

const PAD = 8;
const RADIUS = 14;
function measure(anchor: string): SpotlightRect | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`),
  ).filter((el) => el.getClientRects().length > 0);
  const el = all[all.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight) return null;
  return {
    x: r.left - PAD,
    y: r.top - PAD,
    w: r.width + PAD * 2,
    h: r.height + PAD * 2,
  };
}

function cutout(r: SpotlightRect | null): string {
  if (!r) return "polygon(0 0, 100% 0, 100% 100%, 0 100%)";
  const x1 = r.x,
    y1 = r.y,
    x2 = r.x + r.w,
    y2 = r.y + r.h;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
}

const WINDOWS = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]';

function otherWindowOpen(anchor: string | null): boolean {
  const targets = anchor ? Array.from(document.querySelectorAll(`[data-tour="${anchor}"]`)) : [];
  return Array.from(document.querySelectorAll(WINDOWS)).some(
    (other) => !other.closest("[data-tour-card]") && !targets.some((target) => other.contains(target)),
  );
}

interface Action {
  label: string;
  onClick: () => void;
}

export function Spotlight({
  anchor,
  placement,
  mascot = "curious",
  children,
  progress,
  primary,
  secondary,
  onDone,
}: {
  anchor: string | null;
  placement: SpotlightPlacement;
  mascot?: DogState;
  children: ReactNode;
  progress?: string;
  primary?: Action;
  secondary?: Action;
  onDone: () => void;
}) {
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [cardHeight, setCardHeight] = useState(140);
  const [settled, setSettled] = useState(false);
  const [covered, setCovered] = useState(() => otherWindowOpen(anchor));

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setViewport((prev) => prev.w === window.innerWidth && prev.h === window.innerHeight
          ? prev : { w: window.innerWidth, h: window.innerHeight });
        setRect((prev) => {
          if (!anchor) return null;
          const next = measure(anchor) ?? prev;
          return next?.x === prev?.x && next?.y === prev?.y && next?.w === prev?.w && next?.h === prev?.h ? prev : next;
        });
      });
    };
    update();
    const el = anchor ? document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`) : null;
    const ro = el ? new ResizeObserver(update) : null;
    if (el) ro?.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useLayoutEffect(() => {
    if (!card) return;
    const update = () => {
      const height = card.getBoundingClientRect().height;
      if (height > 0) setCardHeight(height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(card);
    return () => observer.disconnect();
  }, [card]);

  useEffect(() => {
    if (reducedMotion()) {
      setSettled(true);
      return;
    }
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setCovered(otherWindowOpen(anchor));
    const observer = new MutationObserver(() => setCovered(otherWindowOpen(anchor)));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
    return () => observer.disconnect();
  }, [anchor]);

  useEffect(() => {
    let behindWindow = false;
    const onPress = () => {
      behindWindow = otherWindowOpen(anchor);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !behindWindow) onDone();
    };
    window.addEventListener("keydown", onPress, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onPress, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onDone]);

  if (anchor && !rect) return null;

  const position = positionSpotlight(rect, placement, viewport, cardHeight);
  const transform = `translate3d(${position.x}px, ${position.y}px, 0)`;

  return createPortal(
    <div
      className={cn("pointer-events-none fixed inset-0 z-[60]", covered && "invisible")}
      aria-live="polite"
    >
      <div
        className="absolute inset-0 bg-black/55 transition-[clip-path] duration-(--motion-enter) ease-(--ease-out-soft) motion-reduce:transition-none"
        style={{ clipPath: cutout(settled ? rect : null) }}
        aria-hidden="true"
      />
      {rect && (
        <div
          className="absolute ring-2 ring-accent transition-opacity duration-(--motion-enter)"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            opacity: settled ? 1 : 0,
            borderRadius: RADIUS,
            boxShadow:
              "0 0 0 5px color-mix(in srgb, var(--color-accent) 28%, transparent), 0 0 36px 6px color-mix(in srgb, var(--color-accent) 30%, transparent)",
          }}
          aria-hidden="true"
        />
      )}
      <div
        ref={setCard}
        data-tour-card
        className="pointer-events-auto absolute left-0 top-0 w-[320px] transition-transform duration-(--motion-enter) ease-(--ease-out-soft) motion-reduce:transition-none"
        style={{ transform, width: position.width }}
      >
        <div
          role="dialog"
          style={{ maxHeight: position.maxHeight, overflowY: "auto" }}
          className={cn(
            "flex items-start gap-3 rounded-2xl border border-hairline/50 bg-panel p-3.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]",
            position.side === "right" ? "origin-left"
              : position.side === "left" ? "origin-right"
                : position.side === "above" || position.side === "inside" ? "origin-bottom-left"
                  : position.side === "below" ? "origin-top-left" : "origin-center",
            settled ? "animate-spot-in motion-reduce:animate-none" : "opacity-0",
          )}
        >
          <div className="shrink-0 drop-shadow-[0_6px_14px_rgba(0,0,0,0.35)]">
            <DogAvatar
              color="yellow"
              state={mascot}
              size={38}
              trackPointer={false}
            />
          </div>
          <div
            key={anchor ?? "centre"}
            className="min-w-0 flex-1 animate-rise motion-reduce:animate-none"
          >
            <div className="text-[13.5px] leading-relaxed text-ink">
              {children}
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              {primary && (
                <button
                  type="button"
                  autoFocus
                  onClick={primary.onClick}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-transform duration-(--motion-micro) active:scale-[0.98] enabled:hover:brightness-110"
                >
                  {primary.label}
                </button>
              )}
              {progress && (
                <span className="text-[11.5px] tabular-nums text-ink-secondary">
                  {progress}
                </span>
              )}
              {secondary && (
                <button
                  type="button"
                  onClick={secondary.onClick}
                  className="ml-auto text-[12px] text-ink-secondary transition-colors hover:text-ink"
                >
                  {secondary.label}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
