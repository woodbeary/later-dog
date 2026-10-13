import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { MOTION } from "@/lib/motion";
import { t } from "@/lib/i18n";
import { useThreadHelpers, helpersInView } from "@/lib/helpers-state";
import { useTurnReasoning } from "@/lib/turn-reasoning";
import { useActivityPresence } from "@/lib/activity-presence";
import { Puppies } from "./Puppies";
import { ActivityPeek } from "./ActivityPeek";
import type { DogColor } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";

export function TurnPresence({
  avatar,
  visible,
  label = "Thinking",
  answering = false,
  since = null,
  threadId,
  color,
  bodyId,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  since?: number | null;
  threadId?: string;
  color?: DogColor;
  bodyId?: MascotBodyId | null;
}) {
  const helpers = useThreadHelpers(threadId);
  const reasoning = useTurnReasoning(threadId);
  const activity = useActivityPresence(label, since, visible || helpersInView(helpers, Date.now()).length > 0);
  const shownHelpers = helpersInView(helpers, activity.now, visible ? since : null);
  const present = visible || shownHelpers.length > 0;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [threadId]);
  const [mounted, setMounted] = useState(present);
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
    if (handoff) {
      setMounted(false);
      return;
    }
    setOpen(false);
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), MOTION.micro);
    return () => clearTimeout(timer);
  }, [present, answering, mounted]);

  if (!mounted) return null;
  const showWorking = phase === "think";
  return (
    <div className="turn-presence flex flex-col items-start">
      <div
        className={cn(
          "flex items-center gap-2",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {(showWorking || shownHelpers.length > 0) && <button ref={trigger} type="button" onClick={() => setOpen(value => !value)} aria-label={t("chat.activity.peek")} aria-haspopup="dialog" aria-expanded={open} className="flex min-h-9 items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4">
          {showWorking && activity.phrase && <span className="thinking-shimmer animate-shimmer text-[13px] motion-reduce:animate-none">{activity.phrase}</span>}
          {visible && activity.elapsed && <span className="text-[11.5px] tabular-nums text-ink-tertiary">{activity.elapsed}</span>}
          <Puppies helpers={shownHelpers} color={color} bodyId={bodyId} />
          {!activity.phrase && shownHelpers.length === 0 && <span className="text-[11px] text-ink-tertiary">···</span>}
        </button>}
        {open && <ActivityPeek label={visible ? activity.phrase || label : t("chat.helpers.results")} since={visible ? since : null} helpers={shownHelpers} reasoning={reasoning} anchor={trigger} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}
