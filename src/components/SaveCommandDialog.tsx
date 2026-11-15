import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { plainClientError } from "@/lib/plain-client-error";
import {
  cleanCommandName,
  COMMAND_NAME_PATTERN,
  COMMAND_TEXT_LIMIT,
  suggestedCommandName,
  type SavedDogCommand,
} from "@/lib/composer-commands";

export function SaveCommandDialog({ editing, initialName, initialText = "", onClose, onSaved }: {
  editing?: { name: string; text: string };
  initialName?: string;
  initialText?: string;
  onClose: () => void;
  onSaved?: (command: SavedDogCommand | null) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const id = useId();
  const [name, setName] = useState(editing?.name ?? (initialName || suggestedCommandName(initialText)));
  const [text, setText] = useState(editing?.text ?? initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalDialog(dialog, () => { if (!busy) onClose(); });
  const cleanName = cleanCommandName(name);
  const nameOk = COMMAND_NAME_PATTERN.test(cleanName);
  const textOk = text.trim().length > 0;
  const unchanged = Boolean(editing && cleanName === editing.name && text.trim() === editing.text);
  const run = async (work: () => Promise<SavedDogCommand | null>) => {
    setBusy(true);
    setError("");
    try {
      onSaved?.(await work());
      onClose();
    } catch (cause) {
      setError(plainClientError(cause));
      setBusy(false);
      requestAnimationFrame(() => nameField.current?.focus());
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !nameOk || !textOk || unchanged) return;
    void run(async () => {
      const body = JSON.stringify({ name: cleanName, text: text.trim() });
      const result: { command: SavedDogCommand } = editing
        ? await api(`/api/commands/${encodeURIComponent(editing.name)}`, { method: "PATCH", body })
        : await api("/api/commands", { method: "POST", body });
      return result.command;
    });
  };
  const remove = () => {
    if (!editing || busy) return;
    void run(async () => {
      await api(`/api/commands/${encodeURIComponent(editing.name)}`, { method: "DELETE" });
      return null;
    });
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-save-command
        className="flex max-h-full w-full max-w-md flex-col rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl outline-none">
        <h2 id={`${id}-title`} className="text-[16px] font-semibold">{t(editing ? "command.editTitle" : "command.newTitle")}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">{t("command.explain")}</p>
        <form onSubmit={save} className="mt-4 flex min-h-0 flex-col">
          <label htmlFor={`${id}-name`} className="text-[12px] font-medium text-ink-secondary">{t("command.name")}</label>
          <div className="mt-1 flex items-center rounded-lg border border-hairline/50 bg-inset px-3 focus-within:border-focus">
            <span aria-hidden="true" className="text-[14px] text-ink-tertiary">/</span>
            <input ref={nameField} id={`${id}-name`} autoFocus value={name} maxLength={33} disabled={busy} spellCheck={false} autoCapitalize="none"
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 bg-transparent py-2 pl-0.5 text-[14px] text-ink focus:outline-none" />
          </div>
          {name && !nameOk && <p className="mt-1 text-[12px] text-ink-secondary">{t("command.nameRule")}</p>}
          <label htmlFor={`${id}-text`} className="mt-3 text-[12px] font-medium text-ink-secondary">{t("command.text")}</label>
          <textarea id={`${id}-text`} value={text} maxLength={COMMAND_TEXT_LIMIT} disabled={busy} rows={6}
            onChange={(event) => setText(event.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] leading-relaxed text-ink focus:border-focus focus:outline-none" />
          {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
          <div className="mt-4 flex items-center gap-2">
            {editing && (
              <button type="button" disabled={busy} onClick={remove}
                className="rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-secondary hover:bg-control hover:text-ink">{t("common.delete")}</button>
            )}
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={onClose} className="rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover">{t("common.cancel")}</button>
            <button type="submit" disabled={busy || !nameOk || !textOk || unchanged}
              className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel disabled:opacity-40">{t("common.save")}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
