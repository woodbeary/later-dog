import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DogAvatar } from "@/components/Avatar";
import { setEmailGateDone, track } from "@/lib/analytics";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { DogMotion, DogState } from "@/lib/mascot";
import {
  beatWidth,
  completionPatch,
  nextBeat,
  previousBeat,
  WELCOME_BEATS,
  type BeatId,
} from "@/lib/onboarding";
import { api, useStore, type Bot } from "@/state/store";
import { HelloBeat } from "./beats/HelloBeat";
import { MeetYourBotBeat } from "./beats/MeetYourBotBeat";
import { QuietButton } from "./beats/shared";
import { withViewTransition } from "./view-transition";
import { ProgressDots } from "./ProgressDots";

const MASCOT_FOR_BEAT: Record<BeatId, DogState> = {
  hello: "happy",
  bot: "celebrate",
};

function beatTitle(beat: BeatId): string {
  return beat === "hello" ? t("onboarding.welcome", { app: brand().name }) : t("onboarding.bot.title");
}

type Motion = Exclude<DogMotion, "none">;

export function WelcomeFlow({
  bot,
  onDone,
  replay = false,
  initialBeat,
  embedded = false,
  entrance = "arrive",
  hosted = false,
}: {
  bot: Bot | null;
  onDone: () => void;
  replay?: boolean;
  initialBeat?: BeatId;
  embedded?: boolean;
  entrance?: Motion;
  hosted?: boolean;
}) {
  const { dispatch } = useStore();
  const beats = WELCOME_BEATS;
  const [beat, setBeat] = useState<BeatId>(() => (initialBeat && beats.includes(initialBeat) ? initialBeat : "hello"));
  const [mascot, setMascot] = useState<DogState>(MASCOT_FOR_BEAT[beat]);
  const [motion, setMotion] = useState<{ kind: Motion; key: number }>({ kind: "blink", key: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);

  const bump = useCallback((kind: Motion) => setMotion((m) => ({ kind, key: m.key + 1 })), []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => bump(entrance));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    track("onboarding_step", { step: beat, replay });
  }, [beat, replay]);

  const go = useCallback(
    (target: BeatId) => {
      withViewTransition(() => {
        setBeat(target);
        setMascot(MASCOT_FOR_BEAT[target]);
      });
      bump("switch");
    },
    [bump],
  );

  const finish = useCallback(
    async (reason: "completed" | "skipped") => {
      if (finishing.current) return;
      finishing.current = true;
      track("onboarding_completed", { reason, at: beat, replay });
      setEmailGateDone("submitted");
      onDone();
      try {
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {}
    },
    [beat, dispatch, onDone, replay],
  );

  const next = nextBeat(beats, beat);
  const previous = previousBeat(beats, beat);
  const advance = useCallback(() => {
    if (next) go(next);
    else void finish("completed");
  }, [next, go, finish]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void finish("skipped");
      return;
    }
    if (event.key !== "Tab" || !cardRef.current) return;
    const focusable = Array.from(
      cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    const target =
      card.querySelector<HTMLElement>("[autofocus], input, textarea, select") ??
      card.querySelector<HTMLElement>("[data-primary]") ??
      card;
    target.focus({ preventScroll: true });
  }, [beat]);

  const hello = beat === "hello";
  const title = beatTitle(beat);
  const logo = hello ? brand().logo : undefined;
  const beatProps = { onNext: advance, onSkip: advance, setMascot, bump };
  const current = beats.indexOf(beat) + 1;

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-app p-3 sm:p-8",
        embedded ? "relative h-full w-full" : "fixed inset-0 z-50",
      )}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.dialog")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="welcome-card relative flex max-h-full w-full flex-col overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-5 sm:p-8 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.45),0_8px_24px_-12px_rgba(0,0,0,0.25)] outline-none"
        style={{ maxWidth: beatWidth(beat) }}
      >
        <QuietButton onClick={() => void finish("skipped")} className="absolute right-4 top-4">
          {t("onboarding.skipTour")}
        </QuietButton>

        <div className={cn("flex shrink-0", hello ? "flex-col items-center" : "items-center gap-3")}>
          {beat !== "bot" && <div className="welcome-dog flex shrink-0">
            {logo ? (
              <img src={logo} alt="" width={72} height={72} className="h-[72px] w-[72px] object-contain" />
            ) : (
              <DogAvatar
                color="yellow"
                state={mascot}
                motion={motion.kind}
                motionKey={motion.key}
                size={hello ? 72 : 40}
                label={brand().name}
              />
            )}
          </div>}
          <h1 className={cn("welcome-title font-semibold text-ink", hello ? "mt-4 text-[20px]" : "text-[18px]")}>
            {title}
          </h1>
        </div>

        <div key={beat} className="flex shrink-0 flex-col">
          {beat === "hello" && <HelloBeat {...beatProps} hosted={hosted} />}
          {beat === "bot" && (
            <MeetYourBotBeat
              bot={bot}
              onFinish={() => void finish("completed")}
              setMascot={setMascot}
              bump={bump}
            />
          )}
        </div>

        <div className="mt-6 flex shrink-0 items-center justify-between">
          {previous ? (
            <QuietButton onClick={() => go(previous)} className="w-10 text-left">{t("onboarding.back")}</QuietButton>
          ) : (
            <span className="w-10" aria-hidden="true" />
          )}
          <ProgressDots items={beats.map((id) => ({ id }))} index={current - 1} />
          <span className="sr-only" aria-live="polite">
            {t("onboarding.progress", { current, total: beats.length })}
          </span>
          <span className="w-10" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
