import { useState } from "react";
import type { NativeActivity } from "../../shared/native-runs";
import { PANEL_WORDS, stepDetail } from "@/lib/work-panel-model";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="work-panel-copy"
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}
    >
      {copied ? PANEL_WORDS.copied : PANEL_WORDS.copy}
    </button>
  );
}

function Part({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <section>
      <div className="work-panel-detail-label"><span>{label}</span><CopyButton text={text} /></div>
      <pre className="work-panel-box">{text}</pre>
    </section>
  );
}

export function StepPage({ activity }: { activity: NativeActivity | undefined }) {
  if (!activity) return <p className="work-panel-note">{PANEL_WORDS.loading}</p>;
  const detail = stepDetail(activity);
  return (
    <div className="work-panel-detail" data-step-page>
      <Part label={detail.inputLabel} text={detail.input} />
      <Part label={detail.outputLabel} text={detail.output} />
      {detail.shortened && <p className="work-panel-sub mt-2">{PANEL_WORDS.shortened}</p>}
      {detail.hidden && <p className="work-panel-sub mt-2">{PANEL_WORDS.hidden}</p>}
    </div>
  );
}
