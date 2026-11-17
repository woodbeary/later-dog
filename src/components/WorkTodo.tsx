import { Check, LoaderCircle } from "lucide-react";
import type { TodoRow } from "@/lib/work-panel-model";

function Mark({ mark }: { mark: TodoRow["mark"] }) {
  if (mark === "done") return <Check size={16} strokeWidth={2.1} aria-hidden="true" />;
  if (mark === "working") return <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  return <span className="work-panel-ring" data-current={mark === "current" ? "" : undefined} aria-hidden="true" />;
}

export function WorkTodo({ rows }: { rows: readonly TodoRow[] }) {
  return (
    <ul data-work-todo>
      {rows.map((row, index) => (
        <li key={`${index}:${row.text}`} className="work-panel-row work-panel-todo" data-mark={row.mark}>
          <span className="work-panel-mark"><Mark mark={row.mark} /></span>
          <span className="min-w-0">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}
