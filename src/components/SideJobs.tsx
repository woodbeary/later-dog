import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { PANEL_WORDS, type SideJobCard } from "@/lib/work-panel-model";
import { StepGlyph } from "./StepGlyph";

function Card({ card, onOpen }: { card: SideJobCard; onOpen: (card: SideJobCard) => void }) {
  return (
    <button type="button" className="work-panel-card" data-side-job={card.id} onClick={() => onOpen(card)}>
      <span className="work-panel-mark"><StepGlyph kind={card.glyph} /></span>
      <span className="work-panel-step-text">
        <span className="work-panel-card-title">{card.title}</span>
        <span className="work-panel-sub">{card.meta}</span>
      </span>
      <span className="work-panel-chevron"><ChevronRight size={12} aria-hidden="true" /></span>
    </button>
  );
}

export function SideJobs({ running, finished, onOpen }: { running: readonly SideJobCard[]; finished: readonly SideJobCard[]; onOpen: (card: SideJobCard) => void }) {
  const [showFinished, setShowFinished] = useState(false);
  return (
    <div data-side-jobs>
      {running.length ? running.map(card => <Card key={card.id} card={card} onOpen={onOpen} />) : <p className="work-panel-note">{PANEL_WORDS.nothingRunning}</p>}
      {finished.length > 0 && (
        <button type="button" className="work-panel-link" aria-expanded={showFinished} onClick={() => setShowFinished(open => !open)}>
          {PANEL_WORDS.finishedToday}
          <ChevronRight size={12} aria-hidden="true" className={showFinished ? "rotate-90" : undefined} />
        </button>
      )}
      {showFinished && finished.map(card => <Card key={card.id} card={card} onOpen={onOpen} />)}
    </div>
  );
}
