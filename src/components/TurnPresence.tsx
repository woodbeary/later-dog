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
import { NativeWork } from "./NativeWork";
import type { NativeExecutionSelection } from "../../shared/native-run-selectors";
import { useNativeRuns } from "@/lib/native-runs-state";
import { ActivityPeek } from "./ActivityPeek";
import type { DogColor, DogState } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { openWorkPanel } from "@/lib/work-panel";
import { sideJobCount, workLine } from "@/lib/work-line";
import { liveStep, type LiveStep } from "../../shared/step-words";

export function TurnPresence({
  avatar,
  visible,
  label,
  kind = "thinking",
  answering = false,
  since = null,
  threadId,
  botId,
  color,
  bodyId,
  selection,
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
  botId?: string;
  color?: DogColor;
  bodyId?: MascotBodyId | null;
  selection?: NativeExecutionSelection;
  steps?: readonly TurnStep[];
  updates?: readonly string[];
  showDelayMs?: number;
}) {
  const helpers = useThreadHelpers(threadId);
  const nativeRuns = useNativeRuns(threadId);
  const ownerRuns = nativeRuns.filter(run => botId !== undefined && run.botId === botId);
  const nativeRun = ownerRuns.find(run => run.observation === "live" && !run.endedAt);
  const reasoning = useTurnReasoning(threadId);
  const spoken = label && label !== t("chat.activity.thinking") ? label : null;
  const working = visible && !answering;
  const armed = useArmedAfter(working, showDelayMs);
  const activity = useActivityPresence(kind, spoken, since, visible || helpersInView(helpers, Date.now()).length > 0);
  const shownHelpers = ownerRuns[0]?.nativeActivity ? [] : helpersInView(helpers, activity.now, visible ? since : null);
  const [mounted, setMounted] = useState(() => armed || shownHelpers.length > 0);
  const present = armed || shownHelpers.length > 0 || (answering && mounted);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [threadId, botId]);
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
  if (nativeRun && armed && visible && !answering) return <NativeWork run={nativeRun} color={color} bodyId={bodyId} selection={selection} live label={activity.phrase ?? undefined} avatar={avatar} />;
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
          {showWorking && activity.phrase && <span className="thinking-shimmer thinking-phrase animate-shimmer max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] motion-reduce:animate-none">{activity.phrase}</span>}
          {visible && activity.elapsed && <span className="text-[11.5px] tabular-nums text-ink-tertiary">{activity.elapsed}</span>}
          <Puppies helpers={shownHelpers} color={color} bodyId={bodyId} />
        </button>
        {open && <ActivityPeek label={peekLabel} since={visible ? since : null} helpers={shownHelpers} reasoning={reasoning} steps={steps} updates={updates} anchor={trigger} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}

const MINUTE = 60_000;

function useMinuteClock(since: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (since === null) return;
    const untilNext = (at: number) => MINUTE - Math.max(0, at - since) % MINUTE;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = setTimeout(tick, untilNext(at));
    };
    timer = setTimeout(tick, untilNext(Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  return now;
}

export function ChatWorkLine({ bot, working, onOpenDog, fallback = null, face: mood = "working" }: { bot: Bot; working: boolean; onOpenDog: (botId: string) => void; fallback?: LiveStep | null; face?: DogState }) {
  const runs = useNativeRuns(bot.threadId);
  const run = runs.find(candidate => candidate.botId === bot.id && candidate.observation === "live" && !candidate.endedAt);
  const homeStep = (bot as Bot & { step?: LiveStep | null }).step ?? fallback;
  const step = liveStep(run) ?? homeStep;
  const now = useMinuteClock(working && step ? step.startedAt : null);
  const line = workLine({ working, run, step: homeStep, work: bot.work, sideJobs: sideJobCount(run, bot.work), now });
  if (!line) return null;
  const threadId = bot.threadId;
  const face = <span aria-hidden="true" className="flex size-5 shrink-0"><BotAvatar bot={bot} state={mood} size={20} motion="none" motionKey={0} animated={false} label="" /></span>;
  if (line.kind === "helpers" && line.needsYou && line.open) {
    const open = line.open;
    return (
      <div data-work-line className="work-line">
        <button type="button" onClick={() => onOpenDog(open)} className="work-line-button">
          {face}
          <span data-work-line-phrase className="text-[var(--color-waiting-text)]">{line.text}</span>
        </button>
      </div>
    );
  }
  return (
    <div data-work-line className="work-line">
      <button type="button" onClick={() => openWorkPanel({ kind: "work", threadId })} className="work-line-button">
        {face}
        <span data-work-line-phrase className={cn(line.kind === "step" && "thinking-shimmer thinking-phrase animate-shimmer motion-reduce:animate-none")}>{line.kind === "step" ? line.phrase : line.text}</span>
        {line.kind === "step" && line.age && <span data-work-line-age>{` · ${line.age}`}</span>}
      </button>
      {line.kind === "step" && line.sideJobs && (
        <button type="button" data-work-line-side-jobs onClick={() => openWorkPanel({ kind: "side-jobs", threadId })} className="work-line-button">{` · ${line.sideJobs}`}</button>
      )}
    </div>
  );
}
