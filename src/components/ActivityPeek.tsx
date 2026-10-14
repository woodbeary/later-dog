import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Helper, HelperMember } from "../../shared/helpers";
import type { TurnReasoning } from "@/lib/turn-reasoning";
import { t } from "@/lib/i18n";
import { WorkingTimer } from "./WorkingIndicator";
import { helperStateText } from "./Puppies";
import { formatElapsed } from "@/lib/working-time";

function HelperDetails({ helper }: { helper: Helper | HelperMember }) {
  return <div className="space-y-1">
    <div className="flex items-start justify-between gap-3"><span className="font-medium text-ink">{helper.label}</span><span className="shrink-0 text-[11px] text-ink-tertiary">{helperStateText(helper.state)}</span></div>
    {"phase" in helper && helper.phase && <p className="text-[11px] text-ink-tertiary">{helper.phase}</p>}
    {helper.activity && <p className="break-words text-ink-secondary">{helper.activity}</p>}
    <div className="flex flex-wrap gap-x-3 text-[11px] tabular-nums text-ink-tertiary">
      {helper.toolUses !== undefined && <span>{t("chat.helpers.tools", { count: helper.toolUses })}</span>}
      {helper.tokens !== undefined && <span>{t("chat.helpers.tokens", { count: helper.tokens.toLocaleString() })}</span>}
      {helper.durationMs !== undefined && <span>{formatElapsed(helper.durationMs)}</span>}
    </div>
  </div>;
}

export function ActivityPeek({ label, since, helpers, reasoning, anchor, onClose }: {
  label: string; since: number | null; helpers: readonly Helper[]; reasoning: TurnReasoning; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const title = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => {
    const opener = anchor.current;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeAction.current(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); if (opener?.isConnected) opener.focus(); };
  }, [anchor]);
  const box = anchor.current?.getBoundingClientRect();
  const left = Math.max(12, Math.min(box?.left ?? 12, window.innerWidth - 396));
  const top = Math.max(12, (box?.top ?? window.innerHeight) - Math.min(420, window.innerHeight - 24) - 8);
  return createPortal(<div className="fixed inset-0 z-50 bg-black/10" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="fixed inset-x-3 bottom-3 max-h-[min(70vh,420px)] rounded-2xl border border-hairline bg-panel p-4 text-[13px] shadow-xl sm:inset-x-auto sm:bottom-auto sm:left-(--peek-left) sm:top-(--peek-top) sm:w-96" style={{ "--peek-left": `${left}px`, "--peek-top": `${top}px` } as React.CSSProperties}>
      <div className="mb-3 flex items-center justify-between gap-3"><h2 id={title} className="font-medium text-ink">{t("chat.activity.peek")}</h2><button ref={close} type="button" className="rounded-lg p-1.5 text-ink-secondary hover:bg-ink/5 focus-visible:outline-2" aria-label={t("common.close")} onClick={onClose}><X size={16} /></button></div>
      <div tabIndex={0} className="max-h-[min(55vh,330px)] space-y-4 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-2">
        <div><div className="flex items-center justify-between gap-3"><p className="text-ink">{label}</p>{since !== null && <WorkingTimer since={since} className="shrink-0 text-[11px] text-ink-tertiary" />}</div>{reasoning.tokens !== null && <p className="mt-1 text-[11px] text-ink-tertiary">{t("chat.activity.thinkingTokens", { count: reasoning.tokens.toLocaleString() })}</p>}</div>
        {reasoning.streamed ? <div><h3 className="mb-1 text-[11px] font-medium text-ink-tertiary">{t("chat.activity.summary")}</h3><p className="whitespace-pre-wrap break-words text-ink-secondary">{reasoning.clipped ? "… " : ""}{reasoning.text}</p></div> : <p className="text-[11px] text-ink-tertiary">{t("chat.activity.noSummary")}</p>}
        {helpers.length > 0 && <ul className="space-y-3 border-t border-hairline pt-3">{helpers.map(helper => <li key={helper.id}><HelperDetails helper={helper} />{helper.members?.length ? <ul className="mt-2 space-y-2 border-l border-hairline pl-3">{helper.members.map(member => <li key={member.id}><HelperDetails helper={member} /></li>)}</ul> : null}</li>)}</ul>}
      </div>
    </section>
  </div>, document.body);
}
