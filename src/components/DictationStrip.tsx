import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  DICTATION_TICK_MS,
  dictationClock,
  freshDictationMeter,
  paddedDictationLevels,
  stepDictationMeter,
  type DictationMeter,
} from "@/lib/dictation-meter";

const BAR_HEIGHT = 20;
const BAR_MIN = 3;

function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function useDictationMeter(active: boolean, heard: number): { levels: number[]; elapsedMs: number } {
  const heardNow = useRef(heard);
  heardNow.current = heard;
  const [meter, setMeter] = useState<DictationMeter>(() => freshDictationMeter(heard));
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const still = prefersReducedMotion();
    setMeter(freshDictationMeter(heardNow.current));
    setElapsedMs(0);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
      if (!still) setMeter((current) => stepDictationMeter(current, heardNow.current));
    }, DICTATION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return { levels: meter.levels, elapsedMs };
}

export function DictationLevelBars({ levels }: { levels: number[] }) {
  return (
    <div data-dictation-levels aria-hidden="true" className="flex h-5 min-w-0 flex-1 items-center gap-[2.5px] overflow-hidden">
      {paddedDictationLevels(levels).map((level, index) => (
        <span
          key={index}
          data-dictation-level
          className="w-[3px] shrink-0 rounded-full bg-ink transition-[height] duration-75 ease-out motion-reduce:transition-none"
          style={{ height: Math.max(BAR_MIN, Math.round(level * BAR_HEIGHT)) }}
        />
      ))}
    </div>
  );
}

export function DictationStrip({ phase, levels, elapsedMs, onCancel }: {
  phase: "recording" | "transcribing";
  levels: number[];
  elapsedMs: number;
  onCancel(): void;
}) {
  if (phase === "transcribing") {
    return (
      <div className="flex h-8 items-center gap-2 px-1 animate-scrim-in motion-reduce:animate-none">
        <div data-dictation-status role="status" className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t("composer.dictation.transcribing")}</span>
        </div>
      </div>
    );
  }
  return (
    <div
      data-dictation-strip
      role="group"
      aria-label={t("composer.dictation.inProgress")}
      className="flex h-8 items-center gap-2 px-1 animate-scrim-in motion-reduce:animate-none"
    >
      <button
        type="button"
        data-dictation-cancel
        onClick={onCancel}
        aria-label={t("composer.dictation.cancel")}
        title={t("composer.dictation.cancelHint")}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink motion-reduce:transition-none"
      >
        <X size={15} strokeWidth={2.25} />
      </button>
      <DictationLevelBars levels={levels} />
      <span data-dictation-clock className="min-w-[34px] shrink-0 text-right text-[12px] tabular-nums text-ink-secondary">
        {dictationClock(elapsedMs)}
      </span>
    </div>
  );
}
