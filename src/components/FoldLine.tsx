import { ChevronRight } from "lucide-react";
import { openWorkPanel } from "@/lib/work-panel";
import { sideJobsStillGoing } from "../../shared/step-words";

function Sentence({ text }: { text: string }) {
  return (
    <span data-fold-sentence>
      {text}
      <ChevronRight size={12} aria-hidden="true" className="fold-line-chevron" />
    </span>
  );
}

export function FoldLine({ threadId, runId, sentence }: { threadId: string; runId?: string; sentence: string }) {
  return (
    <button type="button" data-fold-line className="fold-line -mb-2 self-start text-left" onClick={() => openWorkPanel(runId ? { kind: "work", threadId, runId } : { kind: "work", threadId })}>
      <Sentence text={sentence} />
    </button>
  );
}

export function SideJobsStillGoing({ threadId, count }: { threadId: string; count: number }) {
  if (count <= 0) return null;
  return (
    <button type="button" data-side-jobs-going className="fold-line -mt-2 self-start text-left" onClick={() => openWorkPanel({ kind: "side-jobs", threadId })}>
      <Sentence text={sideJobsStillGoing(count)} />
    </button>
  );
}
