import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownToLine, CircleAlert, Loader2, RefreshCw, SquareTerminal } from "lucide-react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { useStore, type Bot } from "@/state/store";
import { brand } from "../lib/brand";
import { useMenuMotion } from "./MenuMotion";
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

export function updateButtonBody(phase: UpdateButtonPhase, state: UpdaterState): string {
  const app = brand().name;
  switch (phase) {
    case "downloading":
      return state.percent == null
        ? t("sidebar.update.startingDownload")
        : t("update.body.downloading", { percent: Math.round(state.percent) });
    case "preparing":
      return t("settings.updates.preparing");
    case "downloaded":
      return state.installMode === "handoff" ? t("update.body.readyInstall") : t("update.body.ready", { app });
    case "installing":
      return state.message?.trim() || t("update.body.installing", { app });
    case "handed-off":
      return state.terminalOpened ? t("update.body.handedOffOpened") : t("update.body.handedOff");
    case "error":
      return updateErrorText(state.message);
    case "available":
      return t("releaseCheck.hint");
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

function ProgressRing({ percent }: { percent: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const done = Math.max(0, Math.min(100, percent)) / 100;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
      <circle cx={9} cy={9} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
      <circle
        cx={9}
        cy={9}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - done)}
        className="transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

function UpdateGlyph({ phase, percent }: { phase: UpdateButtonPhase; percent?: number }) {
  if (phase === "downloading" && percent != null) return <ProgressRing percent={percent} />;
  if (phase === "downloading" || phase === "preparing" || phase === "installing") return <Loader2 size={16} className="animate-spin" />;
  if (phase === "error") return <CircleAlert size={17} />;
  if (phase === "handed-off") return <SquareTerminal size={17} />;
  return <ArrowDownToLine size={17} />;
}

const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";
const secondaryAction =
  "rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent";

export interface UpdatePanelProps {
  phase: UpdateButtonPhase;
  state: UpdaterState;
  working: readonly string[];
  pending: boolean;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function UpdatePanel({ phase, state, working, pending, onInstall, onRetry, onClose }: UpdatePanelProps) {
  const title = updateButtonTitle(phase, state);
  const body = updateButtonBody(phase, state);
  const handoff = state.installMode === "handoff";
  const notes = phase === "downloading" || phase === "preparing" || phase === "downloaded" ? state.notes?.trim() : undefined;
  const warning = phase === "downloaded" && !handoff ? workingWarning(working) : null;
  const release = releaseOffer(state);
  const hasPrimary = phase === "downloaded" || (phase === "error" && state.retryable !== false) || Boolean(release);
  const restarting = handoff ? t("settings.updates.opening") : t("settings.updates.restartingShort");
  return (
    <>
      <div className="px-4 pt-3.5">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-secondary">{body}</p>
      </div>
      {phase === "downloading" && state.percent != null && (
        <div className="mx-4 mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, state.percent))}%` }} />
        </div>
      )}
      {notes && (
        <div className="mt-3 border-t border-hairline/40 px-4 pt-3">
          <div className="text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">{t("update.whatsNew")}</div>
          <div data-update-notes className="mt-1.5 max-h-56 overflow-y-auto text-[12.5px] leading-snug text-ink-secondary">
            <UpdateNotes notes={notes} />
          </div>
        </div>
      )}
      {warning && <p className="mx-4 mt-3 rounded-lg bg-warning/10 px-2.5 py-2 text-[12px] leading-snug text-warning">{warning}</p>}
      {phase === "handed-off" && state.command && (
        <code className="mx-4 mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">
          {state.command}
        </code>
      )}
      <div className="mt-3 flex gap-2 px-4 pb-3.5">
        {phase === "downloaded" && (
          <button type="button" disabled={pending} onClick={onInstall} className={primaryAction}>
            {pending ? (
              <>
                <Loader2 size={13} className="animate-spin" /> {restarting}
              </>
            ) : (
              <>
                <RefreshCw size={13} /> {handoff ? t("settings.updates.install") : t("update.restart")}
              </>
            )}
          </button>
        )}
        {phase === "installing" && (
          <button type="button" disabled className={primaryAction}>
            <Loader2 size={13} className="animate-spin" /> {restarting}
          </button>
        )}
        {phase === "error" && state.retryable !== false && (
          <button type="button" disabled={pending} onClick={onRetry} className={primaryAction}>
            {pending ? (
              <>
                <Loader2 size={13} className="animate-spin" /> {t("settings.updates.checking")}
              </>
            ) : (
              t("update.retry")
            )}
          </button>
        )}
        {release && (
          <button
            type="button"
            onClick={() => {
              onClose();
              void openExternalLink(release.url);
            }}
            className={primaryAction}
          >
            <ArrowDownToLine size={13} /> {t("releaseCheck.download")}
          </button>
        )}
        {phase !== "installing" && (
          <button type="button" onClick={onClose} disabled={pending} className={cn(secondaryAction, !hasPrimary && "ml-auto")}>
            {phase === "downloaded" || phase === "available" ? t("releaseCheck.later") : t("update.close")}
          </button>
        )}
      </div>
    </>
  );
}

export function UpdateButton({ align = "right" }: { align?: "left" | "right" }) {
  const state = useUpdaterState();
  const { state: store } = useStore();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const motion = useMenuMotion(open);
  const status = state?.status;
  const phase = updateButtonPhase(state);
  useEffect(() => setPending(false), [status]);
  useEffect(() => {
    if (!phase) setOpen(false);
  }, [phase]);
  usePopoverDismiss(open, rootRef, () => setOpen(false));

  const updater = window.laterdog?.updater;
  if (!state || !phase || !updater) return null;

  const title = updateButtonTitle(phase, state);
  const tone =
    phase === "error"
      ? "text-danger hover:bg-danger/10"
      : phase === "downloaded" || phase === "available"
        ? "bg-accent/15 text-accent hover:bg-accent/25"
        : "text-ink-secondary hover:bg-raised hover:text-ink";

  return (
    <div ref={rootRef} className="contents">
      <button
        type="button"
        data-update-button={phase}
        onClick={() => setOpen((value) => !value)}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={cn("animate-pop-in flex size-8 items-center justify-center rounded-md transition-colors", tone)}
      >
        <UpdateGlyph phase={phase} percent={state.percent} />
      </button>
      {motion.shown && (
        <div
          role="dialog"
          aria-label={title}
          data-update-popover
          className={cn(
            "absolute top-full z-40 mt-1 w-[min(18rem,calc(var(--sidebar-width,18rem)-1.5rem))] overflow-hidden rounded-xl border border-hairline/50 bg-menu shadow-2xl shadow-black/60",
            align === "left" ? "left-0" : "right-0",
            motion.className,
          )}
          {...motion.exitProps}
        >
          <UpdatePanel
            phase={phase}
            state={state}
            working={workingDogNames(store.bots)}
            pending={pending}
            onInstall={() => {
              setPending(true);
              void updater.install();
            }}
            onRetry={() => {
              setPending(true);
              void updater.check();
            }}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
