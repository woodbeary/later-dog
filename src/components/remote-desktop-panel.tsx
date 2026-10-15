import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Monitor, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { isRemoteScreenshotContention, remoteScreenshotSource } from "@/lib/remote-desktop";
import { api, ApiError, useStore, type Bot } from "@/state/store";

function viewerAddress(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error("The host did not return a live desktop link");
  if (raw.startsWith("/vps-viewer/")) return new URL(raw, window.location.origin).toString();
  return raw;
}

export function RemoteDesktopPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(true);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const pageVisible = usePageVisible();
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);

  useEffect(() => {
    setFrame(null);
    setPreviewPending(true);
    setPreviewUnavailable(false);
  }, [bot.id]);

  useEffect(() => {
    const viewer = window.laterdog?.desktopViewer;
    if (!viewer) return;
    let alive = true;
    void viewer.currentState().then((state) => {
      if (alive) setViewerOpen(state.open && state.contextId === bot.id);
    }).catch(() => {});
    const dispose = viewer.onState((state) => {
      if (state.contextId === bot.id || !state.open) setViewerOpen(state.open && state.contextId === bot.id);
    });
    return () => {
      alive = false;
      dispose();
    };
  }, [bot.id]);

  useEffect(() => {
    if (!pageVisible || viewerOpen || pending) return;
    const controller = new AbortController();
    let requestRunning = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let contentionSince: number | null = null;
    const shoot = async () => {
      if (requestRunning || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (previewBusy.current ? 4000 : 30_000))) return;
      requestRunning = true;
      retryDelay = null;
      try {
        const source = remoteScreenshotSource(await api(`/api/bots/${bot.id}/computer/screenshot`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        }));
        if (!controller.signal.aborted && source) {
          setFrame(source);
          setPreviewUnavailable(false);
          contentionSince = null;
        } else if (!controller.signal.aborted) {
          setPreviewUnavailable(true);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof ApiError && isRemoteScreenshotContention(cause)) {
            retryDelay = 1000;
            contentionSince ??= Date.now();
            const prolonged = Date.now() - contentionSince >= 10_000;
            setPreviewUnavailable(prolonged);
            setPreviewPending(!prolonged);
          } else {
            contentionSince = null;
            setPreviewUnavailable(true);
          }
        }
      } finally {
        if (!controller.signal.aborted && retryDelay === null) setPreviewPending(false);
        requestRunning = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = window.setInterval(shoot, 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [bot.id, pageVisible, viewerOpen, pending]);

  const open = async () => {
    setPending(true);
    setError(null);
    let tookControl = false;
    try {
      if (!window.laterdog?.desktopViewer) throw new Error("The desktop viewer is unavailable in this build");
      await api(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action: "take" }),
      });
      tookControl = true;
      const joined = await api(`/api/bots/${bot.id}/computer/join`, {
        method: "POST",
        body: "{}",
      });
      const opened = await window.laterdog.desktopViewer.open(
        viewerAddress(joined.joinUrl),
        `${bot.name}'s live desktop`,
        bot.id,
      );
      if (!opened) throw new Error("later.dog could not open the live desktop");
    } catch (cause) {
      if (tookControl) {
        await api(`/api/bots/${bot.id}/computer/control`, {
          method: "POST",
          body: JSON.stringify({ action: "release" }),
        }).catch(() => {});
      }
      await api(`/api/bots/${bot.id}/computer/viewer-close`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline bg-panel">
      <div className={cn("flex items-center justify-between border-b border-hairline px-5 py-4", padClass)}>
        <div>
          <div className="text-[14px] font-medium text-ink">{bot.name}&apos;s computer</div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">
            {bot.cloudBackend === "vps" ? "Self-hosted VPS" : "Cloud desktop"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          aria-label="Close computer panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 py-5 text-center">
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending || !frame}
          className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-hairline bg-black disabled:cursor-default"
          aria-label={frame ? `Open ${bot.name}'s live desktop` : "VPS preview unavailable"}
        >
          {frame ? (
            <img src={frame} alt={`${bot.name}'s VPS desktop preview`} className="h-full w-full object-contain" />
          ) : previewPending ? (
            <Loader2 size={22} className="animate-spin text-ink-secondary" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-ink-secondary">
              <ImageOff size={24} />
              <span className="text-[11px]">{previewUnavailable ? "Preview unavailable" : "Waiting for preview"}</span>
            </div>
          )}
          {frame && (
            <span className="absolute inset-x-0 bottom-0 bg-black/65 py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              Open live desktop
            </span>
          )}
        </button>
        <div>
          <div className="text-[14px] font-medium text-ink">Open the live desktop</div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            The host creates a temporary, encrypted viewer relay. VPS SSH and VNC credentials stay on the host computer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Monitor size={15} />}
          {pending ? "Opening…" : "Take control"}
        </button>
        {error && (
          <div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-left text-[12px] text-danger">
            {error}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-secondary">
          Taking control needs computer view allowed for this phone on the computer.
        </p>
      </div>
    </aside>
  );
}
