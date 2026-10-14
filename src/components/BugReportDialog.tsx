import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { appVersion, openExternalLink } from "@/lib/app-links";
import { BUG_REPORT_TEXT_LIMIT, bugReportIssue, bugReportOs } from "@/lib/bug-report";
import { useModalDialog } from "@/hooks/use-modal-dialog";

export function BugReportDialog({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const [happened, setHappened] = useState("");
  const [expected, setExpected] = useState("");
  const [includeConversation, setIncludeConversation] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [pending, setPending] = useState(false);
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  useModalDialog(dialog, () => { if (!pending) onClose(); });
  const owner = [...state.bots, ...state.groups].find((item) => item.id === state.selectedId);
  const threadId = state.activeView === "chat" ? owner?.threadId : undefined;
  const issue = bugReportIssue({ happened, expected, conversationId: includeConversation ? threadId : undefined,
    diagnostics, version: appVersion(), os: bugReportOs(window.laterdog?.platform, navigator.userAgent) });
  const copyReport = async () => {
    const result = await copyText(issue.report);
    setError(result === "failed" ? t("common.copyFailed") : "");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !happened.trim()) return;
    setPending(true);
    setError("");
    try {
      if (diagnostics && !saved && window.laterdog?.exportDiagnostics) {
        const path = await window.laterdog.exportDiagnostics();
        if (!path) return;
        setSaved(true);
      }
      await openExternalLink(issue.url);
      setOpened(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  };
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !pending) onClose();
  }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
      className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl outline-none">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-[17px] font-semibold text-ink">{t("bugReport.title")}</h2>
        <button type="button" disabled={pending} onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-2 text-ink-secondary hover:bg-control"><X size={18} /></button>
      </div>
      <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-3 text-[13px] text-ink">
        <label className="block">{t("bugReport.happened")}
          <textarea autoFocus required maxLength={BUG_REPORT_TEXT_LIMIT} value={happened} onChange={(event) => setHappened(event.target.value)}
            className="mt-1 block min-h-28 w-full resize-y rounded-xl border border-hairline/50 bg-inset p-3 outline-none focus:border-accent-border" />
        </label>
        <label className="block">{t("bugReport.expected")}
          <textarea maxLength={BUG_REPORT_TEXT_LIMIT} value={expected} onChange={(event) => setExpected(event.target.value)}
            className="mt-1 block min-h-20 w-full resize-y rounded-xl border border-hairline/50 bg-inset p-3 outline-none focus:border-accent-border" />
        </label>
        {threadId && <label className="flex items-center gap-2"><input type="checkbox" checked={includeConversation} onChange={(event) => setIncludeConversation(event.target.checked)} />{t("bugReport.conversation")}</label>}
        {window.laterdog?.exportDiagnostics && <label className="flex items-center gap-2"><input type="checkbox" checked={diagnostics} onChange={(event) => setDiagnostics(event.target.checked)} />{t("bugReport.diagnostics")}</label>}
        <p className="text-ink-secondary">{t("bugReport.finish")}</p>
        {saved && <p role="status">{t("bugReport.attach")}</p>}
        {issue.shortened && <p className="text-ink-secondary">{t("bugReport.shortened")} <button type="button" className="text-accent-text" onClick={() => void copyReport()}>{t("bugReport.copy")}</button></p>}
        {opened && <p role="status">{t("bugReport.opened")}</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex justify-end"><button type="submit" disabled={pending || !happened.trim()} className="rounded-full bg-accent px-4 py-2 font-medium text-white disabled:opacity-45">{t(pending ? "bugReport.opening" : "bugReport.open")}</button></div>
      </form>
    </div>
  </div>, document.body);
}
