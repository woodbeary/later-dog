import { ChevronRight } from "lucide-react";
import { openWorkPanel } from "@/lib/work-panel";
import { sideJobsStillGoing } from "../../shared/step-words";

export function FoldLine({ threadId, runId, sentence }: { threadId: string; runId: string; sentence: string }) {
  return (
    <button type="button" data-fold-line className="fold-line -mb-2 self-start" onClick={() => openWorkPanel({ kind: "work", threadId, runId })}>
      <span>{sentence}</span>
      <ChevronRight size={12} aria-hidden="true" className="fold-line-chevron" />
    </button>
  );
}

export function SideJobsStillGoing({ threadId, count }: { threadId: string; count: number }) {
  if (count <= 0) return null;
  return (
    <button type="button" data-side-jobs-going className="fold-line -mt-2 self-start" onClick={() => openWorkPanel({ kind: "side-jobs", threadId })}>
      <span>{sideJobsStillGoing(count)}</span>
      <ChevronRight size={12} aria-hidden="true" className="fold-line-chevron" />
    </button>
  );
}
