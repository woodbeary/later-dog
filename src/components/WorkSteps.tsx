import { ChevronRight } from "lucide-react";
import { PANEL_WORDS, type StepRow } from "@/lib/work-panel-model";
import { StepGlyph } from "./StepGlyph";

export function WorkSteps({ rows, trimmed, onOpen, hovered }: { rows: readonly StepRow[]; trimmed: boolean; onOpen: (row: StepRow) => void; hovered?: string }) {
  return (
    <div data-work-steps>
      {rows.map(row => (
        <button
          key={row.id}
          type="button"
          className="work-panel-step"
          data-step-id={row.id}
          data-live={row.live ? "" : undefined}
          data-failed={row.failed ? "" : undefined}
          data-hovered={hovered === row.id ? "" : undefined}
          onClick={() => onOpen(row)}
        >
          <span className="work-panel-mark"><StepGlyph kind={row.glyph} /></span>
          <span className="work-panel-step-text">
            <span>{row.label}</span>
            {row.failed && <span className="work-panel-sub">{PANEL_WORDS.failed}</span>}
          </span>
          <span className="work-panel-time" data-step-time>{row.time}</span>
          <span className="work-panel-chevron" data-step-chevron><ChevronRight size={12} aria-hidden="true" /></span>
        </button>
      ))}
      {trimmed && <p className="work-panel-note">{PANEL_WORDS.trimmed}</p>}
    </div>
  );
}
