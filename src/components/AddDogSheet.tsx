import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";

import { api, useStore, type Bot, type Group } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { track } from "@/lib/analytics";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { takeImportName } from "../../shared/import-name";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup";

export interface AddDogResult {
  members: number;
  connections?: number;
}

export type AddDogSource = { url: string } | { file: File };

export async function readDogFile(file: Pick<File, "name" | "size" | "text">): Promise<unknown> {
  if (file.size > MAX_TEAM_BACKUP_BYTES) throw new Error(t("addDog.tooLarge"));
  const raw = await file.text();
  if (file.name.toLowerCase().endsWith(".md")) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(t("addDog.notAFile"));
  }
}

export function droppedDogFile(files: ArrayLike<Pick<File, "name">> | null | undefined): number {
  return Array.from(files ?? []).findIndex((file) => /\.(laterdog|dogteam)\.json$/i.test(file.name));
}

function loadSource(source: AddDogSource): Promise<unknown> {
  return "file" in source
    ? readDogFile(source.file)
    : api("/api/team-library/github", { method: "POST", body: JSON.stringify({ url: source.url }) });
}

export function addDogTitle(pending: Pick<PendingTeamImport, "members">): string {
  return pending.members.length === 1 ? t("addDog.titleOne") : t("addDog.titleMany", { count: pending.members.length });
}

export function AddDogSheet({ source, onClose, onAdded }: {
  source: AddDogSource;
  onClose: () => void;
  onAdded: (result: AddDogResult) => void;
}) {
  const { state, dispatch } = useStore();
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  useModalDialog(dialog, () => { if (!adding) onClose(); });

  useEffect(() => {
    let cancelled = false;
    setPending(null);
    setError("");
    loadSource(source)
      .then((manifest) => {
        if (cancelled) return;
        const preview = teamImportPreview(manifest);
        if (preview.members.length === 0) throw new Error(t("addDog.noDogs"));
        setPending(preview);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [source]);

  const taken = new Set(state.bots.map((bot) => bot.name.trim().toLowerCase()));
  const names = pending?.members.map((member) => takeImportName(member.name, taken)) ?? [];

  const add = async () => {
    if (!pending || adding) return;
    setAdding(true);
    setError("");
    try {
      const response = (await api("/api/teams/import?mode=add", {
        method: "POST",
        body: JSON.stringify(pending.manifest),
      })) as { bots: Bot[]; groups?: Group[]; routines?: Routine[]; connections?: unknown[] };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots.find((bot) => !bot.hidden);
      if (first) dispatch({ type: "select", id: first.id });
      track("team_imported", { members: response.bots.length, source: "file" in source ? "file" : "link", mode: "add", format: pending.kind });
      onAdded({ members: response.bots.length, ...(response.connections?.length ? { connections: response.connections.length } : {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setAdding(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !adding) onClose();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={!pending && !error} tabIndex={-1}
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
          <h2 id={`${id}-title`} className="text-[16px] font-semibold">{pending ? addDogTitle(pending) : t("addDog.titleOne")}</h2>
          {!pending && !error && (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("addDog.loading")}</p>
          )}
          {pending && (
            <>
              <ul className="mt-3 space-y-2">
                {pending.members.map((member, index) => (
                  <li key={`${member.name}-${index}`} className="flex items-center gap-3">
                    {pending.pictures?.[index]
                      ? <img src={pending.pictures[index]!} alt="" className="size-9 shrink-0 rounded-full object-cover" />
                      : <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-[13px] font-semibold text-ink-secondary">{member.name.slice(0, 1).toUpperCase()}</span>}
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium">{names[index]}</span>
                      {member.title && <span className="block truncate text-[12px] text-ink-secondary">{member.title}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">{t("addDog.safety")}</p>
            </>
          )}
          {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-hairline/40 px-5 py-3">
          <button type="button" disabled={adding} onClick={onClose} className="rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover">{t("common.cancel")}</button>
          <button type="button" disabled={!pending || adding} onClick={() => void add()}
            className="flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel disabled:opacity-40">
            {adding && <Loader2 size={14} className="animate-spin" />}
            {t("common.add")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
