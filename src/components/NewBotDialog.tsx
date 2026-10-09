import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

export interface NewBotDialogProps {
  onClose?: () => void;
  section?: string;
  onCreated?: (bot: Bot) => void | Promise<void>;
  preserveSelection?: boolean;
}

const pillCls = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";
const rowLabelCls = "block text-[12px] text-ink-secondary";
const rowInputCls = "mt-1 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none";

export function NewBotDialog({ onClose, section, onCreated, preserveSelection = false }: NewBotDialogProps = {}) {
  const { state, dispatch } = useStore();
  const companion = typeof window !== "undefined" && Boolean(window.laterdog?.remoteClient?.active);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection | undefined>(undefined);
  const [error, setError] = useState("");
  const saving = state.botCreationPending;
  const dialog = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const closeRef = useRef(() => {});
  closeRef.current = () => {
    if (onClose) onClose();
    else dispatch({ type: "toggleNewBot", open: false });
  };

  useEffect(() => {
    if (companion) return;
    let cancelled = false;
    void api<{ modelSelection: ModelSelection; suggestedName: string }>("/api/bot-defaults")
      .then((result) => {
        if (cancelled) return;
        setModelSelection(result.modelSelection);
        setName((current) => current || result.suggestedName || "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [companion]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Disabling the focused Create button drops focus to the page in Chromium.
  // Keep keyboard dismissal and focus trapping inside the pending dialog.
  useEffect(() => { if (saving) dialog.current?.focus(); }, [saving]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || (event.target instanceof Node && !root.contains(event.target))) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')]
        .filter((control) => control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);

  const trimmedName = name.trim();
  const create = () => {
    if (saving || !trimmedName) return;
    setError("");
    dispatch({
      type: "newBot",
      name: trimmedName,
      title: purpose.trim() || undefined,
      modelSelection,
      section,
      preserveSelection,
      onCreated: (bot) => {
        Promise.resolve().then(() => onCreated?.(bot)).catch((cause: unknown) => {
          dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
        if (alive.current) closeRef.current();
      },
      onError: (message) => { if (alive.current) setError(message); },
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.newBot")}
        aria-busy={saving}
        tabIndex={-1}
        className="w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-ink">{t("sidebar.newBot")}</h2>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={18} className="pointer-events-none" />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <fieldset disabled={saving} className="mt-4 min-w-0 rounded-xl bg-card">
            <div className="px-4 py-3">
              <label htmlFor="new-dog-name" className={rowLabelCls}>{t("botSettings.simple.name")}</label>
              <input
                id="new-dog-name"
                autoFocus
                required
                maxLength={BOT_PROFILE_LIMITS.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={rowInputCls}
              />
            </div>
            <div className="border-t border-hairline/40 px-4 py-3">
              <label htmlFor="new-dog-purpose" className={rowLabelCls}>{t("newBot.purpose")}</label>
              <input
                id="new-dog-purpose"
                maxLength={BOT_PROFILE_LIMITS.title}
                placeholder={t("newBot.purposePlaceholder")}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                className={rowInputCls}
              />
            </div>
          </fieldset>
          {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => closeRef.current()} className={pillCls}>{t("common.cancel")}</button>
            <button
              type="submit"
              disabled={saving || !trimmedName}
              className={cn(pillCls, "flex items-center gap-2 bg-accent text-white hover:bg-accent hover:brightness-110")}
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              {t("newBot.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
