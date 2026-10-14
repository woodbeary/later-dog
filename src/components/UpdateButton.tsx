import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownToLine, CircleAlert, Loader2, SquareTerminal } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { dismissUpdateDialog, requestUpdateDialog, subscribeUpdateDialog, updateDialogOpen } from "@/lib/update-request";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { useStore, type Bot } from "@/state/store";
import { brand } from "../lib/brand";
import { releaseOffer } from "./ReleaseCheck";

export type UpdateButtonPhase = "downloading" | "preparing" | "downloaded" | "installing" | "handed-off" | "error" | "available";

type WorkingBot = Pick<Bot, "name" | "busy" | "activity" | "tasks">;

export function updateButtonPhase(state: UpdaterState | null): UpdateButtonPhase | null {
  switch (state?.status) {
    case "downloading":
    case "preparing":
    case "downloaded":
    case "installing":
    case "handed-off":
    case "error":
      return state.status;
    default:
      return releaseOffer(state) ? "available" : null;
  }
}

export function workingDogNames(bots: readonly WorkingBot[]): string[] {
  return bots
    .filter((bot) => bot.busy || bot.activity === "working" || bot.tasks?.some((task) => task.busy || task.activity === "working"))
    .map((bot) => bot.name);
}

export function workingWarning(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return t("update.working.one", { name: names[0]! });
  return t("update.working.many", { count: names.length });
}

export function updateErrorText(message?: string): string {
  const text = message?.trim();
  if (!text) return t("update.failed.unknown");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::/i.test(text)) return t("update.failed.offline");
  return text.split("\n")[0]!.slice(0, 200);
}

const DOWNLOAD_PAGE = "https://later.dog";

const tidy = (text: string) => text.replace(/ {2,}/g, " ").trim();

export function updateButtonTitle(phase: UpdateButtonPhase, state: UpdaterState): string {
  const app = brand().name;
  const version = state.version ?? "";
  switch (phase) {
    case "downloading":
      return tidy(t("update.title.downloading", { app, version }));
    case "preparing":
      return tidy(t("update.title.preparing", { app, version }));
    case "downloaded":
      return tidy(t("update.title.ready", { app, version }));
    case "installing":
      return state.installMode === "handoff" ? t("sidebar.update.openingTerminal") : t("sidebar.update.installing");
    case "handed-off":
      return t("sidebar.update.handedOff");
    case "error":
      return t("update.title.failed");
    case "available":
      return t("releaseCheck.available", { app, version: releaseOffer(state)?.version ?? "" });
  }
}

const noteHeading = ({ children }: { children?: ReactNode }) => <p className="mt-2.5 font-semibold text-ink first:mt-0">{children}</p>;

const NOTE_COMPONENTS: Components = {
  h1: noteHeading,
  h2: noteHeading,
  h3: noteHeading,
  h4: noteHeading,
  p: ({ children }) => <p className="mt-1.5 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-1 list-disc space-y-1 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1 list-decimal space-y-1 pl-4">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-control px-1 font-mono text-[11.5px]">{children}</code>,
  img: () => null,
  a: ({ href, children }) =>
    href && /^https:\/\//i.test(href) ? (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void openExternalLink(href);
        }}
        className="text-accent hover:underline"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function UpdateNotes({ notes }: { notes: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={NOTE_COMPONENTS}>
      {notes}
    </Markdown>
  );
}

export type UpdatePillKind = "quiet" | "update" | "download" | "problem";

export interface UpdatePillView {
  kind: UpdatePillKind;
  label: string;
  busy: boolean;
  percent?: number;
}

export function updatePillView(phase: UpdateButtonPhase, state: UpdaterState): UpdatePillView {
  switch (phase) {
    case "downloading":
      return state.percent == null
        ? { kind: "quiet", label: t("update.pill.starting"), busy: true }
        : { kind: "quiet", label: t("update.pill.downloading", { percent: Math.round(state.percent) }), busy: true, percent: state.percent };
    case "preparing":
      return { kind: "quiet", label: t("update.pill.preparing"), busy: true };
    case "downloaded":
      return { kind: "update", label: t("update.pill.update"), busy: false };
    case "installing":
      return { kind: "quiet", label: t("update.pill.installing"), busy: true };
    case "handed-off":
      return { kind: "quiet", label: t("sidebar.update.handedOff"), busy: false };
    case "error":
      return { kind: "problem", label: state.retryable === false ? t("update.pill.failed") : `${t("update.pill.failed")} · ${t("update.pill.retry")}`, busy: false };
    case "available":
      return { kind: "download", label: t("update.pill.download"), busy: false };
  }
}

function PillGlyph({ phase, busy }: { phase: UpdateButtonPhase; busy: boolean }) {
  if (busy) return <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />;
  if (phase === "error") return <CircleAlert size={14} aria-hidden="true" className="shrink-0" />;
  if (phase === "handed-off") return <SquareTerminal size={14} aria-hidden="true" className="shrink-0" />;
  return <ArrowDownToLine size={14} aria-hidden="true" className="shrink-0" />;
}

const PILL_TONE: Record<UpdatePillKind, string> = {
  quiet: "bg-raised/60 text-ink-secondary",
  update: "bg-update text-white hover:bg-update-hover font-medium",
  download: "bg-update text-white hover:bg-update-hover font-medium",
  problem: "bg-danger/10 text-danger hover:bg-danger/15",
};

export function UpdatePill({ compact = false }: { compact?: boolean }) {
  const state = useUpdaterState();
  const updater = window.laterdog?.updater;
  const phase = updateButtonPhase(state);
  if (!state || !phase || !updater) return null;
  const view = updatePillView(phase, state);
  const title = updateButtonTitle(phase, state);
  const act = () => {
    if (phase === "downloaded" || phase === "installing") return requestUpdateDialog();
    if (phase === "error" && state.retryable !== false) return void updater.check();
    const release = releaseOffer(state);
    if (phase === "available" && release) void openExternalLink(release.url);
  };
  const inert = view.busy || phase === "handed-off" || (phase === "error" && state.retryable === false);
  if (compact && view.kind === "quiet" && phase !== "downloading") return null;
  return (
    <button
      type="button"
      data-update-pill={phase}
      data-update-kind={view.kind}
      aria-label={title}
      title={title}
      disabled={inert && phase !== "installing"}
      onClick={act}
      className={cn(
        "animate-pop-in relative flex shrink-0 items-center overflow-hidden rounded-full text-[12.5px] transition-colors disabled:cursor-default",
        compact ? "size-8 justify-center" : "h-8 w-full justify-center gap-1.5 px-3.5",
        PILL_TONE[view.kind],
      )}
    >
      {view.percent != null && !compact && (
        <span aria-hidden="true" data-update-progress className="absolute inset-y-0 left-0 bg-control transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, view.percent))}%` }} />
      )}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <PillGlyph phase={phase} busy={view.busy} />
        {!compact && <span className="truncate">{view.label}</span>}
      </span>
    </button>
  );
}

export interface UpdateDialogProps {
  phase: UpdateButtonPhase;
  state: UpdaterState;
  working: readonly string[];
  pending: boolean;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function UpdateDialogCard({ phase, state, working, pending, onInstall, onRetry, onClose }: UpdateDialogProps) {
  const app = brand().name;
  const version = state.version ?? "";
  const handoff = state.installMode === "handoff";
  const release = releaseOffer(state);
  const notes = state.notes?.trim();
  const warning = phase === "downloaded" && !handoff ? workingWarning(working) : null;
  const title = phase === "error" ? t("update.title.failed") : tidy(t("update.confirm.title", { app, version }));
  const body = phase === "error" ? updateErrorText(state.message)
    : phase === "handed-off" ? (state.terminalOpened ? t("update.body.handedOffOpened") : t("update.body.handedOff"))
    : phase === "installing" ? (state.message?.trim() || t("update.body.installing", { app }))
    : handoff ? t("update.body.readyInstall")
    : t("update.confirm.body", { app });
  const ready = phase === "downloaded";
  const restarting = handoff ? t("settings.updates.opening") : t("settings.updates.restartingShort");
  return (
    <>
      <div className="flex items-start gap-3.5 px-5 pt-5">
        <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-update text-white shadow-sm">
          <ArrowDownToLine size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-snug text-ink">{title}</h2>
          <p className="mt-1 text-[13px] leading-snug text-ink-secondary">{body}</p>
        </div>
      </div>
      {notes && ready && (
        <div className="mx-5 mt-4 border-t border-hairline/40 pt-3">
          <div className="text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">{t("update.whatsNew")}</div>
          <div data-update-notes className="mt-1.5 max-h-44 overflow-y-auto text-[12.5px] leading-snug text-ink-secondary">
            <UpdateNotes notes={notes} />
          </div>
        </div>
      )}
      {phase === "error" && (
        <button type="button" data-update-download onClick={() => { onClose(); void openExternalLink(DOWNLOAD_PAGE); }} className="mx-5 mt-2 block text-left text-[12.5px] leading-snug text-update hover:underline">
          {t("update.downloadInstead")}
        </button>
      )}
      {phase === "handed-off" && state.command && (
        <code className="mx-5 mt-3 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">{state.command}</code>
      )}
      {warning && <p data-update-warning className="mx-5 mt-3 truncate text-[12px] text-warning" title={warning}>{warning}</p>}
      <div className="mt-4 flex justify-end gap-2 px-5 pb-5">
        {phase !== "installing" && (
          <button type="button" onClick={onClose} disabled={pending} className="rounded-full bg-control px-4 py-1.5 text-[13px] text-ink hover:bg-control-hover disabled:opacity-50">
            {ready ? t("releaseCheck.later") : t("update.close")}
          </button>
        )}
        {(ready || phase === "installing") && (
          <button type="button" data-update-confirm disabled={pending || phase === "installing"} onClick={onInstall}
            className="flex items-center gap-1.5 rounded-full bg-update px-4 py-1.5 text-[13px] font-medium text-white hover:bg-update-hover disabled:cursor-default disabled:opacity-70">
            {pending || phase === "installing" ? <><Loader2 size={13} className="animate-spin" /> {restarting}</> : handoff ? t("settings.updates.install") : t("update.confirm.update")}
          </button>
        )}
        {phase === "error" && state.retryable !== false && (
          <button type="button" data-update-confirm disabled={pending} onClick={onRetry} className="rounded-full bg-update px-4 py-1.5 text-[13px] font-medium text-white hover:bg-update-hover disabled:opacity-70">
            {pending ? <Loader2 size={13} className="animate-spin" /> : t("update.retry")}
          </button>
        )}
        {release && (
          <button type="button" onClick={() => { onClose(); void openExternalLink(release.url); }} className="rounded-full bg-update px-4 py-1.5 text-[13px] font-medium text-white hover:bg-update-hover">
            {t("releaseCheck.download")}
          </button>
        )}
      </div>
    </>
  );
}

export function UpdateDialog() {
  const open = useSyncExternalStore(subscribeUpdateDialog, updateDialogOpen, updateDialogOpen);
  const state = useUpdaterState();
  const { state: store } = useStore();
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const phase = updateButtonPhase(state);
  const status = state?.status;
  useEffect(() => setPending(false), [status]);
  const updater = window.laterdog?.updater;
  const shown = open && Boolean(state && phase && updater);
  useEffect(() => {
    if (open && !shown) dismissUpdateDialog();
  }, [open, shown]);
  if (!shown || !state || !phase || !updater) return null;
  return <UpdateDialogFrame dialogRef={dialogRef} title={updateButtonTitle(phase, state)} onClose={dismissUpdateDialog}>
    <UpdateDialogCard
      phase={phase}
      state={state}
      working={workingDogNames(store.bots)}
      pending={pending}
      onInstall={() => { setPending(true); void updater.install(); }}
      onRetry={() => { setPending(true); void updater.check(); }}
      onClose={dismissUpdateDialog}
    />
  </UpdateDialogFrame>;
}

function UpdateDialogFrame({ dialogRef, title, onClose, children }: { dialogRef: React.RefObject<HTMLDivElement | null>; title: string; onClose: () => void; children: ReactNode }) {
  useModalDialog(dialogRef, onClose);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-update-dialog className="w-full max-w-sm animate-pop-in rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl shadow-black/50 outline-none">
        {children}
      </div>
    </div>,
    document.body,
  );
}
