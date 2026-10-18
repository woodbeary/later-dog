import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { api, useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";

export const SECTION_NAME_LIMIT = 60;

export function sectionNameTaken(name: string, current: string, taken: readonly (string | undefined)[]): boolean {
  const wanted = name.trim().toLowerCase();
  return wanted !== current.trim().toLowerCase() && taken.some((candidate) => candidate?.trim().toLowerCase() === wanted);
}

export function SectionRenameDialog({ section, onClose, onRenamed }: {
  section: string;
  onClose: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}) {
  const { state, dispatch } = useStore();
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const [name, setName] = useState(section);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useModalDialog(dialog, () => { if (!saving) onClose(); });
  const trimmed = name.trim();
  const unchanged = trimmed === section.trim();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !trimmed || unchanged) return;
    if (sectionNameTaken(trimmed, section, [...(state.sections ?? []), ...state.bots.map((bot) => bot.section), ...state.groups.map((group) => group.section)])) {
      setError(t("section.duplicate"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result: { sections: string[]; bots?: Bot[] } = await api(`/api/sidebar-sections?section=${encodeURIComponent(section)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      dispatch({ type: "sections", sections: result.sections });
      for (const bot of result.bots ?? []) dispatch({ type: "botPatched", bot });
      onRenamed(section, trimmed);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl outline-none">
        <h2 id={`${id}-title`} className="text-[16px] font-semibold">{t("section.rename")}</h2>
        <form onSubmit={(event) => void save(event)}>
          <input autoFocus value={name} maxLength={SECTION_NAME_LIMIT} disabled={saving} aria-label={t("section.name")}
            onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)}
            className="mt-3 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] text-ink focus:border-focus focus:outline-none" />
          {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={onClose} className="rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover">{t("common.cancel")}</button>
            <button type="submit" disabled={saving || !trimmed || unchanged}
              className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel disabled:opacity-40">{t("common.save")}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
