import { useState } from "react";
import { lastMovedLine, PANEL_WORDS, startedWords, stopQuestion, type SideJobCard } from "@/lib/work-panel-model";

type StopState = "idle" | "confirm" | "stopping" | "failed";

export function SideJobPage({ card, botName, now, onStop }: { card: SideJobCard | undefined; botName: string; now: number; onStop: (card: SideJobCard) => Promise<void> }) {
  const [stop, setStop] = useState<StopState>("idle");
  if (!card) return <p className="work-panel-note">{PANEL_WORDS.nothingRunning}</p>;
  const confirm = async () => {
    setStop("stopping");
    try { await onStop(card); setStop("idle"); } catch { setStop("failed"); }
  };
  return (
    <div data-side-job-page>
      <div className="work-panel-facts">
        <div>{startedWords(card.startedAt, now)}</div>
        <div>{lastMovedLine(now - card.lastActivityAt)}</div>
      </div>
      {card.doing && (
        <>
          <div className="work-panel-section">{PANEL_WORDS.doing}</div>
          <p className="work-panel-doing">{card.doing}</p>
        </>
      )}
      {card.canStop && !card.finished && (stop === "confirm" ? (
        <div className="work-panel-confirm" data-stop-confirm>
          <p>{stopQuestion(botName)}</p>
          <div className="work-panel-confirm-actions">
            <button type="button" data-danger="" onClick={() => void confirm()}>{PANEL_WORDS.stopConfirm}</button>
            <button type="button" onClick={() => setStop("idle")}>{PANEL_WORDS.cancel}</button>
          </div>
        </div>
      ) : stop === "stopping" ? (
        <p className="work-panel-stop" data-stopping>{PANEL_WORDS.stopping}</p>
      ) : (
        <>
          <button type="button" className="work-panel-stop" data-stop-job onClick={() => setStop("confirm")}>{PANEL_WORDS.stop}</button>
          {stop === "failed" && <p className="work-panel-stop" data-stop-failed>{PANEL_WORDS.stopFailed}</p>}
        </>
      ))}
    </div>
  );
}
