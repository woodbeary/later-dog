import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { MOTION } from "@/lib/motion";
import { t } from "@/lib/i18n";
import { useThreadHelpers, helpersInView } from "@/lib/helpers-state";
import { useTurnReasoning } from "@/lib/turn-reasoning";
import { useActivityPresence, useArmedAfter } from "@/lib/activity-presence";
import { ROW_SHOW_DELAY_MS } from "@/lib/thinking-row";
import type { ActivityKind } from "@/lib/live-activity";
import type { TurnStep } from "@/lib/turn-details";
import { Puppies } from "./Puppies";
import { ActivityPeek } from "./ActivityPeek";
import type { DogColor } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";

export function TurnPresence({
  avatar,
  visible,
  label,
  kind = "thinking",
  answering = false,
  since = null,
  threadId,
  color,
  bodyId,
  steps = [],
  updates = [],
  showDelayMs = ROW_SHOW_DELAY_MS,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  kind?: ActivityKind;
  answering?: boolean;
  since?: number | null;
  threadId?: string;
  color?: DogColor;
  bodyId?: MascotBodyId | null;
  steps?: readonly TurnStep[];
  updates?: readonly string[];
  showDelayMs?: number;
}) {
  const helpers = useThreadHelpers(threadId);
  const reasoning = useTurnReasoning(threadId);
  const spoken = label && label !== t("chat.activity.thinking") ? label : null;
  const working = visible && !answering;
  const armed = useArmedAfter(working, showDelayMs);
  const activity = useActivityPresence(kind, spoken, since, visible || helpersInView(helpers, Date.now()).length > 0);
  const shownHelpers = helpersInView(helpers, activity.now, visible ? since : null);
  const [mounted, setMounted] = useState(() => armed || shownHelpers.length > 0);
  const present = armed || shownHelpers.length > 0 || (answering && mounted);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [threadId]);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (present) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    setOpen(false);
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), MOTION.micro);
    return () => clearTimeout(timer);
  }, [present, answering, mounted]);

  if (!mounted) return null;
  const showWorking = phase === "think";
  const interactive = showWorking || shownHelpers.length > 0;
  const peekLabel = visible ? activity.phrase : t("chat.helpers.results");
  return (
    <div className="turn-presence flex flex-col items-start" data-turn-presence={phase}>
      <div
        className={cn(
          "flex items-center",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={!interactive}
          aria-hidden={interactive ? undefined : true}
          tabIndex={interactive ? undefined : -1}
          aria-label={t("chat.activity.peek")}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="thinking-row flex min-h-9 items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:pointer-events-none"
        >
          {avatar}
          {showWorking && activity.phrase && <span key={activity.phrase} className="thinking-shimmer thinking-phrase animate-shimmer text-[13px] motion-reduce:animate-none">{activity.phrase}</span>}
          {visible && activity.elapsed && <span className="text-[11.5px] tabular-nums text-ink-tertiary">{activity.elapsed}</span>}
          <Puppies helpers={shownHelpers} color={color} bodyId={bodyId} />
        </button>
        {open && <ActivityPeek label={peekLabel} since={visible ? since : null} helpers={shownHelpers} reasoning={reasoning} steps={steps} updates={updates} anchor={trigger} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}
