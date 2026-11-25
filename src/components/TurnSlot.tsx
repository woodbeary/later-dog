import { useEffect, useRef, useState } from "react";
import type { Bot, Message } from "@/state/store";
import { useNativeRuns } from "@/lib/native-runs-state";
import { useTurnSlotLine } from "@/lib/turn-slot-state";
import { openWorkPanel } from "@/lib/work-panel";
import { pendingApprovals } from "./PendingApproval";
import { openQuestion } from "@/lib/open-question";
import { BotAvatar } from "./Avatar";
import type { LiveStep } from "../../shared/step-words";
import "../turn-slot.css";

export function turnNeedsYouWords(bot: Bot, messages: readonly Message[] = bot.messages): string | null {
  if (openQuestion(messages)) return "Waiting for your answer";
  if (pendingApprovals([...messages]).length > 0) return "Waiting for your OK";
  if (bot.activity !== "waiting-on-you" && bot.work?.kind !== "needs-you") return null;
  const last = messages.findLast(message => message.role !== "user");
  if (last?.secureForm || last?.kind === "secret") return "Waiting for your details";
  if (last?.kind === "connector") return "Waiting for you to sign in";
  if (last?.card?.takeoverRequest) return "Your turn at the screen";
  return bot.work?.kind === "needs-you" && bot.work.hold ? `${bot.work.hold.why === "off" ? "Turn on" : "Sign in to"} ${bot.work.hold.account} to carry on` : "Waiting for your OK";
}

function useStillFace(): boolean {
  const read = () => typeof window !== "undefined" && typeof document !== "undefined" && (document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  const [still, setStill] = useState(read);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setStill(read());
    media?.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduced-motion"] });
    return () => { media?.removeEventListener("change", update); observer.disconnect(); };
  }, []);
  return still;
}

export function TurnSlot({ bot, working, fallback, onOpenDog, messages = bot.messages }: {
  bot: Bot;
  working: boolean;
  fallback?: LiveStep | null;
  onOpenDog: (botId: string) => void;
  messages?: readonly Message[];
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const runs = useNativeRuns(bot.threadId);
  const run = runs.find(candidate => candidate.botId === bot.id && candidate.observation === "live" && !candidate.endedAt);
  const homeStep = (bot as Bot & { step?: LiveStep | null }).step ?? fallback;
  const deliveryMessage = messages.findLast(message => message.role === "user" && message.id.startsWith("optimistic-"));
  const delivery = deliveryMessage ? { at: deliveryMessage.at, held: deliveryMessage.held } : undefined;
  const ask = turnNeedsYouWords(bot, messages);
  const key = `${bot.threadId}:${bot.turnStartedAt ?? run?.id ?? deliveryMessage?.id ?? "live"}`;
  const { line, shown } = useTurnSlotLine({ working: working || !bot.busy && bot.work?.kind === "running", busy: Boolean(bot.busy), name: bot.name, turnKey: key, since: bot.turnStartedAt ?? run?.startedAt, run, step: homeStep, work: bot.work, delivery, ask, readAt: messages.findLast(message => message.role === "user" && message.steered && message.readAt !== undefined)?.readAt });
  const still = useStillFace();
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement("");
    if (!line?.wait) return;
    const timer = setTimeout(() => setAnnouncement(line.spoken), 10_000);
    return () => clearTimeout(timer);
  }, [line?.key, line?.wait, line?.spoken]);
  if (!line && !delivery && !working && !ask) return null;
  const open = () => {
    if (!line) return;
    if (line.openDog) { onOpenDog(line.openDog); return; }
    if (line.destination === "card") {
      const pane = slotRef.current?.closest("main");
      const cards = [...pane?.querySelectorAll<HTMLElement>('[data-question-card], [data-approval-card], [data-needs-you-proxy="waiting"], [data-takeover-card], [data-secure-form]') ?? []];
      const card = cards.find(candidate => candidate.getBoundingClientRect().height > 0);
      if (card) {
        card.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
        card.querySelector<HTMLElement>('button:not([disabled]), input, textarea, [tabindex="0"]')?.focus({ preventScroll: true });
        return;
      }
    }
    openWorkPanel({ kind: line.destination === "side-jobs" ? "side-jobs" : "work", threadId: bot.threadId });
  };
  return (
    <div ref={slotRef} data-turn-slot data-work-line data-slot-shown={shown ? "true" : "false"} className="turn-slot">
      {line && (
        <>
          <button type="button" className="turn-slot-button" onClick={open} aria-label={line.spoken} aria-hidden={shown ? undefined : true} tabIndex={shown ? 0 : -1} data-turn-urgent={line.urgent ? "" : undefined}>
            <span aria-hidden="true" className="turn-slot-face"><BotAvatar bot={bot} state={line.face} size={24} animated={!still} motion={still ? "none" : line.urgent ? "alert" : line.face === "thinking" ? "thinking" : line.face === "working" ? "working" : "none"} motionKey={line.key.length} trackPointer={false} lookAround={0} label="" /></span>
            <span data-work-line-phrase className="turn-slot-phrase">{line.words}</span>
            {line.age && <span data-work-line-age className="turn-slot-age">{` · ${line.age}`}</span>}
          </button>
          {line.sideJobs && <button type="button" data-work-line-side-jobs className="turn-slot-side-jobs" aria-hidden={shown ? undefined : true} tabIndex={shown ? 0 : -1} onClick={() => openWorkPanel({ kind: "side-jobs", threadId: bot.threadId })}>{` · ${line.sideJobs}`}</button>}
        </>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  );
}
