import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FileDown, Loader2, Share } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { t, tFromServer } from "@/lib/i18n";
import { navigateMenu } from "@/lib/menu-keys";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { describePart, describeSkip, dogShareBody, notesLine, preparePictures, saveShareFile, type ShareResponse } from "@/lib/dog-share";

export function DogShareButton({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, root, () => setOpen(false));
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-raised";
  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}
        aria-label={t("dogShare.button")} title={t("dogShare.button")}
        className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink">
        <Share size={17} className="pointer-events-none" />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={t("dogShare.button")}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
            navigateMenu(event);
          }}
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-hairline/50 bg-menu p-1.5 shadow-2xl shadow-black/40">
          <button type="button" role="menuitem" className={item} onClick={() => {
            setOpen(false);
            dispatch({ type: "duplicateBot", botId: bot.id });
          }}>
            <Copy size={15} className="shrink-0 text-ink-secondary" />{t("dogShare.copy")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); setSaving(true); }}>
            <FileDown size={15} className="shrink-0 text-ink-secondary" />{t("dogShare.file")}
          </button>
        </div>
      )}
      {saving && <DogShareFileDialog bot={bot} onClose={() => setSaving(false)} />}
    </div>
  );
}

export function DogShareFileDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const [includeMemory, setIncludeMemory] = useState(true);
  const [includePicture, setIncludePicture] = useState(true);
  const [picture, setPicture] = useState<{ avatars: Record<string, string>; skipped: string[] } | null>(null);
  const [preview, setPreview] = useState<ShareResponse | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const request = useRef(0);
  const { id: botId, avatarUrl, avatarCrop } = bot;
  const hasPicture = Boolean(avatarUrl && avatarCrop && avatarCrop !== "mascot");
  useModalDialog(dialog, () => { if (!saving) onClose(); });

  useEffect(() => {
    let cancelled = false;
    void preparePictures([{ id: botId, avatarUrl, avatarCrop }]).then((result) => {
      if (cancelled) return;
      setPicture({
        avatars: result.avatars,
        skipped: result.skipped.map((skip) => `${t("teamShare.field.picture")} — ${tFromServer(`teamShare.skip.${skip.reason}`, skip.reason)}`),
      });
    }).catch(() => { if (!cancelled) setPicture({ avatars: {}, skipped: [] }); });
    return () => { cancelled = true; };
  }, [botId, avatarUrl, avatarCrop]);

  const avatars = includePicture && picture ? picture.avatars : undefined;
  useEffect(() => {
    if (!picture) return;
    const ask = ++request.current;
    setPreview(null);
    api<ShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(dogShareBody({ botId, includeMemory, avatars, dryRun: true })) })
      .then((result) => { if (ask === request.current) { setPreview(result); setError(""); } })
      .catch((cause) => { if (ask === request.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [botId, picture, includeMemory, avatars]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<ShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(dogShareBody({ botId, includeMemory, avatars })) });
      saveShareFile(result.filename, result.document);
      setSaved(result.filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const skipped = [
    ...(includePicture ? picture?.skipped ?? [] : []),
    ...(preview?.skipped.map((skip) => describeSkip(skip, preview.document)) ?? []),
  ];
  const counts = preview?.summary.counts;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
          <h2 id={`${id}-title`} className="text-[16px] font-semibold">{t("dogShare.fileTitle", { name: bot.name })}</h2>
          {saved ? (
            <p role="status" className="mt-3 flex items-center gap-2 text-[13px]"><Check size={15} className="shrink-0" />{t("dogShare.saved", { filename: saved })}</p>
          ) : (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("dogShare.fileIntro", { name: bot.name })}</p>
              {counts ? (
                <p data-dog-share-counts className="mt-3 text-[12.5px] text-ink-secondary">
                  {t("dogShare.counts", { skills: counts.skills, routines: counts.routines, connections: counts.connections })}
                </p>
              ) : !error && (
                <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("teamShare.preparing")}</p>
              )}
              <fieldset disabled={saving} className="mt-4 space-y-2 text-[13px]">
                {hasPicture && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-ink" checked={includePicture} onChange={(event) => setIncludePicture(event.target.checked)} />
                    {t("dogShare.includePicture")}
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-ink" checked={includeMemory} onChange={(event) => setIncludeMemory(event.target.checked)} />
                  {t("teamShare.includeNotes")}
                </label>
                <p className="pl-6 text-[12px] leading-relaxed text-ink-secondary">{notesLine(includeMemory)}</p>
              </fieldset>
              {preview?.document.package.connections?.length ? (
                <div className="mt-3 text-[12px] text-ink-secondary">
                  <div className="font-medium text-ink">{t("teamShare.addresses")}</div>
                  <ul className="mt-1 space-y-0.5">
                    {preview.document.package.connections.map((connection) => (
                      <li key={connection.key} className="break-all"><span className="text-ink">{connection.label}</span> · {connection.mcp.url}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview && preview.redacted.length > 0 && (
                <div className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[12px] text-ink-secondary">
                  <div className="font-medium text-ink">{t("teamShare.redacted")}</div>
                  <ul className="mt-1 list-disc pl-5">{preview.redacted.map((part) => <li key={part}>{describePart(part, preview.document)}</li>)}</ul>
                </div>
              )}
              {skipped.length > 0 && (
                <div className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[12px] text-ink-secondary">
                  <div className="font-medium text-ink">{t("teamShare.skipped")}</div>
                  <ul className="mt-1 list-disc pl-5">{skipped.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
                </div>
              )}
            </>
          )}
          {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-hairline/40 px-5 py-3">
          {saved ? (
            <button type="button" onClick={onClose} className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel">{t("teamShare.done")}</button>
          ) : (
            <>
              <button type="button" disabled={saving} onClick={onClose} className="rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover">{t("common.cancel")}</button>
              <button type="button" disabled={saving || !preview} onClick={() => void save()}
                className="flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel disabled:opacity-40">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {t("dogShare.save")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
