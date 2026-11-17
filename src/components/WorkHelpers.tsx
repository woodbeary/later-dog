import type { ReactNode } from "react";
import type { HelperRow } from "@/lib/work-panel-model";

export function WorkHelpers({ rows, face, onOpen }: { rows: readonly HelperRow[]; face: (botId: string) => ReactNode; onOpen: (row: HelperRow) => void }) {
  return (
    <div data-work-helpers>
      {rows.map(row => (
        <button key={row.botId} type="button" className="work-panel-row work-panel-helper" onClick={() => onOpen(row)}>
          <span className="work-panel-mark">{face(row.botId)}</span>
          <span className="work-panel-helper-text">
            <span>{row.name}</span>
            <span className="work-panel-helper-phrase" data-needs-you={row.needsYou ? "" : undefined}>{row.phrase}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
