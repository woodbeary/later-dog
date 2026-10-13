import { useEffect, useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { DogColor, DogState } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { DogAvatar } from "./Avatar";

const STIR_MS = 900;

interface DogLook {
  color: DogColor;
  bodyId?: MascotBodyId;
  size?: number;
}

export function WakingDog({ color, bodyId, size = 76, waking }: DogLook & { waking: boolean }) {
  const [stirred, setStirred] = useState(false);
  useEffect(() => {
    if (!waking) {
      setStirred(false);
      return;
    }
    const timer = setTimeout(() => setStirred(true), STIR_MS);
    return () => clearTimeout(timer);
  }, [waking]);
  const state: DogState = !waking ? "sleeping" : stirred ? "loading" : "waking";
  return (
    <span
      aria-hidden="true"
      data-dog-state={state}
      className={cn("relative inline-flex shrink-0", !waking && "dog-snooze")}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
    >
      <DogAvatar color={color} bodyId={bodyId} state={state} size={size} trackPointer={false} />
    </span>
  );
}

export function WakeDog({ color, bodyId, size = 76, label, hint, busy = false, onWake, children }: DogLook & {
  label: string;
  hint?: ReactNode;
  busy?: boolean;
  onWake: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const aboutId = `${id}-about`;
  const hintId = `${id}-hint`;
  const describedBy = [children ? aboutId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div data-wake-dog={busy ? "waking" : "asleep"} className="flex flex-col items-center gap-2.5">
      <button
        type="button"
        aria-label={label}
        aria-describedby={describedBy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          if (!busy) onWake();
        }}
        className={cn(
          "group cursor-pointer rounded-2xl p-2 transition-colors hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none",
          "aria-disabled:cursor-progress aria-disabled:hover:bg-transparent",
        )}
      >
        <span className="block transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-active:translate-y-0 group-aria-disabled:translate-y-0 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
          <WakingDog color={color} bodyId={bodyId} size={size} waking={busy} />
        </span>
      </button>
      {children && (
        <div id={aboutId} className="flex flex-col items-center gap-1">
          {children}
        </div>
      )}
      {hint && (
        <p id={hintId} className="max-w-[17rem] text-[12px] leading-relaxed text-ink-tertiary">
          {hint}
        </p>
      )}
    </div>
  );
}
