import { cloudEngineOf } from "@/lib/remote-desktop";
import { canWorkOnCloud } from "../../shared/cloud-computer";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  Hand,
  Laptop,
  Loader2,
  Maximize2,
  Monitor,
  X,
} from "lucide-react";
import { api, ApiError, currentTaskBot, useStore, type Bot } from "@/state/store";
import { effectivePlace, placeOffered } from "@/lib/place";
import type { CloudBackend } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { listenLiveFrames } from "@/lib/live-events";
import { CloudScreenPreview } from "./CloudScreenPreview";
import { CloudTasksSection } from "./CloudTasksSection";
import { isActiveTurnRefusal, isRemoteScreenshotContention } from "@/lib/remote-desktop";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { MacLocalControl } from "./MacLocalControl";
import { useDesktopPermissions } from "@/lib/use-desktop-permissions";
import { checklistHost } from "@/lib/desktop-permissions";
import { LocalComputerPermissions } from "./LocalComputerPermissions";
import {
  busyBoatView,
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerPermissionGap,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  isReadyBoatState,
  resolveBoatPanelAction,
  shouldPollCloudPreview,
} from "@/lib/local-computer";
import { allowComputer } from "@/lib/allow-computer";
import { openPlaceAction, placeBlocked, placeFacts, placeViewFor, usePlaceSeat } from "@/lib/place-view";
import { cloudRefusal, type PlaceActionId, type PlaceFacts, type PlaceView } from "../../shared/place-view";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { CloudTrialOffer, useCloudTrial } from "./CloudTrial";
import { SleepingDog } from "./AccountCharge";
import { WakeDog, WakingDog } from "./WakeDog";

class LocalizedPanelError extends Error {
  constructor(
    readonly key: LocaleKey,
    readonly problem?: string | null,
    readonly fallbackKey?: LocaleKey,
  ) {
    super(key);
  }
}

function panelErrorText(error: Error | string | null): string | null {
  if (error instanceof LocalizedPanelError) {
    return t(error.key, error.fallbackKey ? { problem: error.problem ?? t(error.fallbackKey) } : undefined);
  }
  return error instanceof Error ? error.message : error;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "busy-boat"
  | "ready"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "team-boat"
  | "show-ready-boat"
  | "show-sleeping-boat"
  | "show-pending-boat"
  | "cloud-new"
  | "cloud-asleep"
  | "off"
  | "error";

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

const PANEL_WIDTH_KEY = "laterdog-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {}
  return PANEL_DEFAULT_WIDTH;
}

const TAKEOVER_INTENT_MS = 60_000;

export function ComputerPanel({
  bot: profileBot,
}: {
  bot: Bot;
}) {
  const { padClass } = useCaptionChrome();
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {}
  };
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistPanelWidth(panelWidth);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persistPanelWidth(next);
      return next;
    });
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => setSeparatorWidth(panel.offsetWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const onSeparatorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  const { state, dispatch, flushBotPatches } = useStore();
  const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
  const livePlace = effectivePlace(profileBot, liveTask);
  const threadBot = currentTaskBot(profileBot);
  const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${profileBot.cloudBackend ?? "box"}:${threadBot.modelSelection.instanceId}`;
  const [autoSurface, setAutoSurface] = useState<{ key: string; surface: Bot["computer"] } | null>(null);
  const autoSurfaceCurrent = autoSurface?.key === connectionKey;
  const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
  const bot = { ...threadBot, computer: livePlace === "auto"
    ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
  const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}:${bot.cloudBackend ?? "box"}`;
  const viewerConnection = useRef(viewerConnectionKey);
  viewerConnection.current = viewerConnectionKey;
  const desktopJoin = useRef<AbortController | null>(null);
  useEffect(() => () => desktopJoin.current?.abort(), [viewerConnectionKey]);
  const placeLive = Boolean(bot.busy);
  const threadPath = useCallback((suffix: string) =>
    `/api/bots/${profileBot.id}/${suffix}?threadId=${encodeURIComponent(profileBot.threadId)}`,
  [profileBot.id, profileBot.threadId]);
  const canManageCloud = profileBot.computer === "cloud" && livePlace === "cloud";
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const {
    checklist: desktopPermissions,
    busy: permissionBusy,
    request: requestPermission,
    openSettings: openPermissionSettings,
  } = useDesktopPermissions({ active: !capabilities.remote && capabilities.host.platform === "darwin" && !localAvailable });
  const permissionHost = checklistHost(typeof window === "undefined" ? undefined : window.laterdog);
  const localPermissionGap = localComputerPermissionGap({ capabilities, permissions: desktopPermissions });
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal });
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal, permissions: desktopPermissions });
  const placeSeat = usePlaceSeat(state.config, capabilities.host.platform);
  const [phase, setPhase] = useState<Phase>("checking");
  const askingForGrants = phase === "local-unavailable" && providerSupportsLocal && localPermissionGap.length > 0;
  const [persistedComputerSelection, setPersistedComputerSelection] = useState<{
    botId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
    section: string;
  } | null>(null);
  const [resolvedComputerSelection, setResolvedComputerSelection] = useState<{
    botId: string;
    threadId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
  } | null>(null);
  const [teamComputer, setTeamComputer] = useState<{
    id: string; name: string; botId: string; section: string;
  } | null>(null);
  const cloudBackend = bot.cloudBackend ?? "box";
  const computerSelectionPersisted = Boolean(
    persistedComputerSelection
      && persistedComputerSelection.botId === bot.id
      && persistedComputerSelection.computer === profileBot.computer
      && persistedComputerSelection.cloudBackend === cloudBackend
      && persistedComputerSelection.section === (bot.section?.trim() ?? ""),
  );
  const computerStatusCurrent = Boolean(
    resolvedComputerSelection
      && resolvedComputerSelection.botId === bot.id
      && resolvedComputerSelection.threadId === bot.threadId
      && resolvedComputerSelection.computer === bot.computer
      && resolvedComputerSelection.cloudBackend === cloudBackend,
  );
  const currentTeamComputer = computerStatusCurrent && livePlace === "auto" && cloudBackend === "box"
    && teamComputer?.botId === bot.id && teamComputer.section === (bot.section?.trim() ?? "")
    ? teamComputer : null;
  const cloudPreviewReady = computerStatusCurrent && shouldPollCloudPreview({
    computer: bot.computer,
    cloudBackend,
    phase,
    botId: bot.id,
    resolvedBotId: resolvedComputerSelection?.botId ?? null,
    resolvedComputer: resolvedComputerSelection?.computer ?? null,
    resolvedCloudBackend: resolvedComputerSelection?.cloudBackend ?? null,
  });
  const updateComputerSelection = useCallback((patch: { computer: Bot["computer"] }) => {
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    dispatch({ type: "updateBot", botId: bot.id, patch });
  }, [bot.id, dispatch]);
  useEffect(() => {
    let alive = true;
    setPersistedComputerSelection(null);
    void flushBotPatches(bot.id).then((persistedBot) => {
      if (!alive) return;
      if (persistedBot && !persistedComputerSelectionMatches({
        computer: profileBot.computer,
        cloudBackend,
        persistedBot,
      })) return;
      if (persistedBot && (persistedBot.section?.trim() ?? "") !== (bot.section?.trim() ?? "")) return;
      setPersistedComputerSelection({
        botId: bot.id,
        computer: profileBot.computer,
        cloudBackend,
        section: bot.section?.trim() ?? "",
      });
    });
    return () => {
      alive = false;
    };
  }, [bot.id, profileBot.computer, bot.section, cloudBackend, flushBotPatches]);
  const [boatState, setBoatState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [previewError, setPreviewError] = useState<Error | string | null>(null);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [pending, setPending] = useState<"join" | "provision" | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const errorText = panelErrorText(error);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (livePlace !== "auto" || !computerSelectionPersisted) return;
    const controller = new AbortController();
    setAutoSurface(null);
    void api(threadPath("computer"), { signal: controller.signal }).then((status) => {
      if (controller.signal.aborted) return;
      const surface = status.surface;
      setAutoSurface({ key: connectionKey, surface:
        surface === "cloud" || surface === "local" || surface === "off"
          ? surface : undefined });
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause : String(cause));
      setPhase("error");
    });
    return () => controller.abort();
  }, [connectionKey, livePlace, computerSelectionPersisted, threadPath, retry]);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  useEffect(() => {
    let alive = true;
    const dv = window.laterdog?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  const cloudSupported = canWorkOnCloud(cloudEngineOf(selectedInstance));
  useEffect(() => {
    let alive = true;
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    setPolledFrame(null);
    setPreviewError(null);
    setError(null);
    if (!computerSelectionPersisted || !surfaceReady) return;
    if (bot.computer === undefined) {
      setPhase("auto-unavailable");
      return;
    }

    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError(new LocalizedPanelError("computer.err.localEngine"));
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      return;
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    api(threadPath("computer"))
      .then((status) => {
        if (!alive) return;
        const action = resolveBoatPanelAction({
          computer: livePlace === "cloud" ? "cloud" : undefined,
          configured: Boolean(status.configured),
          boatState: typeof status.box?.state === "string" ? status.box.state : null,
          canUseCloud: cloudSupported,
          autoLocal: false,
          teamComputer: typeof status.teamComputer?.id === "string" && typeof status.teamComputer?.name === "string",
          busy: profileBot.busy,
        });
        setResolvedComputerSelection({
          botId: bot.id,
          threadId: bot.threadId,
          computer: bot.computer,
          cloudBackend,
        });
        if (!status.configured && bot.computer === "cloud" && !status.teamComputer) {
          setPhase("unconfigured");
          return;
        }
        if (action === "team-boat") {
          setTeamComputer({ id: status.teamComputer.id, name: status.teamComputer.name,
            botId: bot.id, section: bot.section?.trim() ?? "" });
          setBoatState(typeof status.box?.state === "string" ? status.box.state : status.configured ? "missing" : "unavailable");
          setError(typeof status.problem === "string" ? status.problem : null);
          setPhase("team-boat");
          return;
        }
        if (action === "attach-ready-boat" || (bot.computer === "cloud" && action === "show-ready-boat")) {
          setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
          setPhase("ready");
          return;
        }
        setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
        setPhase(action);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [
    bot.id,
    bot.threadId,
    bot.computer,
    bot.section,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    providerSupportsLocal,
    selectedInstance?.driverKind,
    cloudSupported,
    computerSelectionPersisted,
    surfaceReady,
    canManageCloud,
    livePlace,
    threadPath,
  ]);

  useEffect(() => {
    if (phase !== "busy-boat") return;
    let alive = true;
    const check = () => {
      if (!profileBot.busy && livePlace === "cloud") {
        setRetry((n) => n + 1);
        return;
      }
      api(threadPath("computer"))
        .then((status) => {
          if (!alive) return;
          const state = typeof status.box?.state === "string" ? status.box.state : null;
          setBoatState(state);
          if (isReadyBoatState(state)) setPhase("ready");
        })
        .catch(() => {});
    };
    const timer = window.setInterval(check, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, threadPath, profileBot.busy, livePlace]);

  const pageVisible = usePageVisible();
  const lastLiveAt = useRef(0);
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);
  useEffect(() => {
    lastLiveAt.current = 0;
    if (!cloudPreviewReady) return;
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "screen" || frame.botId !== bot.id || frame.threadId !== bot.threadId) return;
        lastLiveAt.current = Date.now();
        setPolledFrame({ png: frame.png, mime: frame.mime ?? "image/png" });
        setPreviewError(null);
        setPreviewRefreshing(false);
      },
    });
  }, [cloudPreviewReady, bot.id, bot.threadId]);

  useEffect(() => {
    if (!cloudPreviewReady || viewerOpen || !pageVisible || pending || controlPending) return;
    let inFlight = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let contentionSince: number | null = null;
    const controller = new AbortController();
    setPreviewError(null);
    setPreviewRefreshing(true);
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (previewBusy.current ? 4000 : 30_000))) return;
      if (previewBusy.current && Date.now() - lastLiveAt.current < 10_000) return;
      inFlight = true;
      retryDelay = null;
      const startedAt = Date.now();
      try {
        const { png, format } = await api(threadPath("computer/screenshot"), {
          method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          if (typeof png !== "string" || !png.trim()) throw new LocalizedPanelError("computer.err.emptyFrame");
          setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
          setPreviewError(null);
          setPreviewRefreshing(false);
          contentionSince = null;
        }
      } catch (e) {
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          if (e instanceof ApiError && isRemoteScreenshotContention(e)) {
            retryDelay = 1000;
            contentionSince ??= Date.now();
            const prolonged = Date.now() - contentionSince >= 10_000;
            setPreviewError(prolonged ? e : null);
            setPreviewRefreshing(!prolonged);
          } else {
            contentionSince = null;
            setPreviewRefreshing(false);
            setPreviewError(e instanceof Error && e.name === "TimeoutError"
              ? new LocalizedPanelError("computer.err.frameTimeout")
              : e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
          }
        }
      } finally {
        inFlight = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = setInterval(shoot, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [cloudPreviewReady, threadPath, cloudBackend, viewerOpen, pageVisible, pending, controlPending, previewRetry]);

  const frameSrc = !computerStatusCurrent ? null :
    cloudPreviewReady || (bot.computer === "cloud" && phase === "starting")
      ? polledFrame && `data:${polledFrame.mime};base64,${polledFrame.png}`
      : null;
  const previewOpensDesktop = Boolean(frameSrc && cloudPreviewReady);

  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const requestControl = useCallback(async (action: ComputerControlAction) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
    });
    return snap;
  }, [bot.id, dispatch]);

  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    return transitionComputerControlLease({
      action,
      syncNativeBrowser: true,
      requestControl,
      setNativeBrowserControl,
    });
  }, [requestControl, setNativeBrowserControl]);

  const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      await transitionControl(action);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  }, [transitionControl]);

  const viewerWasOpen = useRef(false);
  useEffect(() => {
    if (viewerWasOpen.current && !viewerOpen && control.held) void controlAction("release");
    viewerWasOpen.current = viewerOpen;
  }, [viewerOpen, control.held, controlAction]);

  const openDesktop = async () => {
    const controller = new AbortController();
    desktopJoin.current = controller;
    const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    let fallbackTab: Window | null = null;
    if (!window.laterdog?.desktopViewer && !window.laterdog?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await transitionControl("take");
        tookControl = true;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");

      let viewerUrl: string | null = null;
      if (cloudPreviewReady) {
        const result = await api(threadPath("computer/join"), { method: "POST", signal: controller.signal });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");
      if (!viewerUrl) throw new LocalizedPanelError("computer.err.noDesktopLink");

      if (window.laterdog?.desktopViewer) {
        const opened = await window.laterdog.desktopViewer.open(viewerUrl, t("computer.viewerTitle", { name: bot.name }), bot.id, {
          label: t("takeover.inControl"),
          done: t("computer.handBack"),
        });
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.laterdog?.openExternal) {
        const opened = await window.laterdog.openExternal(viewerUrl);
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktopLink");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new LocalizedPanelError("computer.err.popupBlocked");
      }
    } catch (e) {
      fallbackTab?.close();
      if (tookControl) await transitionControl("release").catch(() => {});
      if (ownsConnection()) setError(e instanceof Error ? e : String(e));
    } finally {
      if (desktopJoin.current === controller) {
        desktopJoin.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };

  const takeoverIntent = state.takeoverIntent?.botId === bot.id ? state.takeoverIntent : null;
  useEffect(() => {
    if (!takeoverIntent) return;
    const clear = () => dispatch({ type: "takeoverIntent", intent: null });
    const left = takeoverIntent.at + TAKEOVER_INTENT_MS - Date.now();
    if (left <= 0 || viewerOpen) {
      clear();
      return;
    }
    if (!previewOpensDesktop || !control.held || pending || controlPending) {
      const timer = window.setTimeout(clear, left);
      return () => window.clearTimeout(timer);
    }
    clear();
    void openDesktop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeoverIntent, previewOpensDesktop, control.held, viewerOpen, pending, controlPending]);

  const [autoStartCloud, setAutoStartCloud] = useState(false);
  const takeFreeCloud = () => {
    setAutoStartCloud(true);
    updateComputerSelection({ computer: "cloud" });
  };
  const { status: trialNow } = useCloudTrial();
  const cloudReady = trialNow?.state === "active" || state.config?.box?.configured === true;
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    if (profileBot.computer !== undefined && profileBot.computer !== "off") return;
    if (livePlace === "cloud" || livePlace === "local") return;
    if (!cloudReady || profileBot.busy) return;
    booted.current = true;
    takeFreeCloud();
  });
  const provisioning = useRef(false);
  const startCloudComputer = () => {
    if (provisioning.current) return;
    provisioning.current = true;
    setPending("provision");
    setError(null);
    setPhase("starting");
    api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" })
      .then((result) => {
        setBoatState(result.state ?? null);
        setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
        setError(null);
        setPhase("ready");
      })
      .catch((e) => {
        if (isActiveTurnRefusal(e)) {
          setPhase("busy-boat");
          return;
        }
        setError(isRemoteScreenshotContention({ status: Number(e?.status ?? 409), message: String(e?.message ?? "") })
          ? new LocalizedPanelError("computer.err.changing")
          : e.message);
        setPhase("error");
      })
      .finally(() => {
        provisioning.current = false;
        setPending(null);
      });
  };

  const [allowingComputer, setAllowingComputer] = useState(false);
  const letUseComputer = async () => {
    if (allowingComputer) return;
    setAllowingComputer(true);
    setError(null);
    try {
      await allowComputer(profileBot);
    } catch (cause) {
      setError(cause instanceof Error ? cause : String(cause));
    } finally {
      setAllowingComputer(false);
    }
  };

  useEffect(() => {
    if (!autoStartCloud || pending !== null || profileBot.busy) return;
    if (phase !== "cloud-new" && phase !== "cloud-asleep") return;
    setAutoStartCloud(false);
    startCloudComputer();
  });

  const openedStart = useRef(false);
  useEffect(() => {
    if (openedStart.current) return;
    if (phase !== "cloud-new" && phase !== "cloud-asleep") return;
    const action = cloudView.action?.id;
    if ((action !== "start" && action !== "wake") || !panelOffers(action) || pending !== null) return;
    openedStart.current = true;
    startCloudComputer();
  });

  const busyBoat = busyBoatView(boatState, profileBot.busy === true);
  const cloudComputer: PlaceFacts["computer"] = !computerStatusCurrent || livePlace !== "cloud" || cloudBackend !== "box" ? undefined
    : phase === "starting" ? "starting"
      : phase === "busy-boat" ? (busyBoat.spinner ? "starting" : busyBoat.line === "computer.cloud.asleep" ? "asleep" : "none")
        : phase === "ready" ? "on"
          : boatState === "archived" || boatState === "stopped" ? "asleep" : undefined;
  const viewOf = (place: PlaceFacts["place"], refusal?: PlaceFacts["refusal"]): PlaceView => placeViewFor({
    ...placeFacts({
      bot, place, seat: placeSeat, config: state.config, instances: state.instances,
      local: { ready: localSelectable, reason: localDisabledReason ?? t("computer.unavailableLocal") },
      ...(place === "cloud" ? { computer: cloudComputer } : {}),
      ...(place === "auto" && currentTeamComputer ? { teamComputer: currentTeamComputer.name } : {}),
    }),
    ...(refusal ? { refusal } : {}),
  });
  const cloudRefused = bot.computer === "cloud" && cloudBackend === "box" && phase === "error" && error && !(error instanceof LocalizedPanelError)
    ? cloudRefusal({ message: errorText ?? "", status: Number((error as { status?: unknown }).status ?? 0) || undefined }, state.config?.box?.included === true)
    : undefined;
  const cloudView = viewOf("cloud", cloudRefused);
  const autoView = viewOf("auto");
  const runPlaceAction = (id: PlaceActionId) => {
    if (id === "start" || id === "wake") return startCloudComputer();
    if (id === "try-again") return setRetry((n) => n + 1);
    if (id === "allow-computer") return void letUseComputer();
    openPlaceAction(id, { botId: profileBot.id, threadId: profileBot.threadId }, dispatch);
  };
  const panelOffers = (id: PlaceActionId | undefined): id is PlaceActionId => Boolean(id) && id !== "watch" && id !== "open-computer-panel"
    && ((id !== "start" && id !== "wake") || (canManageCloud && !profileBot.busy));
  const placeActionButton = (view: PlaceView, className = "mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-control-hover") =>
    view.action && panelOffers(view.action.id) ? (
      <button type="button" data-testid="place-action" onClick={() => runPlaceAction(view.action!.id)} className={className}>
        {view.action.label}
      </button>
    ) : null;
  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: cloudView.line,
    "busy-boat": cloudView.line,
    unconfigured: cloudView.line,
    "auto-unavailable": autoView.line,
    "team-boat": autoView.line,
    "show-ready-boat": t("computer.phase.showReadyBoat"),
    "show-sleeping-boat": t("computer.phase.showSleepingBoat"),
    "show-pending-boat": t("computer.phase.showPendingBoat"),
    "cloud-new": cloudView.line,
    "cloud-asleep": cloudView.line,
    "local-unavailable": localDisabledReason ?? t("computer.phase.localUnavailable"),
    off: viewOf("off").line,
    error: bot.computer === "cloud" && (cloudRefused || placeBlocked(cloudView)) ? cloudView.line : t("computer.phase.error"),
  } satisfies Record<Exclude<Phase, "ready" | "local">, string>;
  const dogLook = { color: bot.color, bodyId: bot.mascotBody ?? undefined };
  const cloudActionId = cloudView.action?.id;
  const cloudWakeId = cloudActionId === "start" || cloudActionId === "wake" ? cloudActionId : null;
  const cloudSleeps = phase === "cloud-new" || phase === "cloud-asleep";
  const wakeDog = phase === "off"
    ? { label: t("computer.turnOn", { name: bot.name }), hint: t("computer.turnOnHint"), busy: false, onWake: () => updateComputerSelection({ computer: "cloud" }) }
    : cloudSleeps && cloudWakeId && panelOffers(cloudWakeId) && pending === null
      ? {
        label: t(cloudWakeId === "wake" ? "computer.wakeDog" : "computer.turnOn", { name: bot.name }),
        hint: t(cloudWakeId === "wake" ? "computer.wakeHint" : "computer.turnOnHint"),
        busy: false,
        onWake: () => runPlaceAction(cloudWakeId),
      }
      : null;
  const dogStirs = phase === "busy-boat" && busyBoat.spinner;
  const dogSleeps = (cloudSleeps && (!cloudActionId || cloudWakeId !== null)) || (phase === "busy-boat" && !busyBoat.spinner);
  const emptyLine = (
    <span className="text-[12px]">
      {currentTeamComputer
        ? autoView.line
        : cloudPreviewReady
        ? t("computer.waitingFrame")
        : phase === "ready"
          ? t("computer.autoChooseCloudOpen")
        : phase === "local"
          ? t("computer.onThisMac", { name: bot.name })
          : emptyState[phase]}
    </span>
  );

  return (
    <aside
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      style={{ width: panelWidth }}
    >
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      <div className={cn("flex items-center justify-between gap-2 px-4 py-3", padClass)}>
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink">
          <Monitor size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          {t("computer.tab.computer")}
          {placeLive && bot.computer !== undefined && bot.computer !== "off" && (
            <span className="size-1.5 rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="computer-live" />
          )}
        </h2>
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          aria-label={t("computer.close")}
          title={t("computer.close")}
        >
          <X size={18} />
        </button>
      </div>

      <div className="contents" data-pane-in="">
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="relative mt-2 flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
            <CloudScreenPreview
              key={`${bot.id}:${bot.threadId}:${bot.computer}:${cloudBackend}`}
              src={frameSrc}
              name={bot.name}
              error={panelErrorText(previewError)}
              refreshing={previewRefreshing}
              retry={previewRetry}
              starting={phase === "starting"}
              dog={dogLook}
              opening={pending === "join"}
              disabled={controlPending}
              onOpen={() => void openDesktop()}
              onRetry={(discardFrame) => {
                lastLiveAt.current = 0;
                if (discardFrame) setPolledFrame(null);
                setPreviewError(null);
                setPreviewRefreshing(true);
                setPreviewRetry((n) => n + 1);
              }}
            />
          ) : frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
              title={t("computer.openLiveDesktop")}
            >
              <img
                src={frameSrc}
                alt={t("computer.screenOf", { name: bot.name })}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                {t("computer.open")}
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {wakeDog ? (
                <WakeDog {...dogLook} size={56} label={wakeDog.label} hint={wakeDog.hint} busy={wakeDog.busy} onWake={wakeDog.onWake}>
                  {emptyLine}
                </WakeDog>
              ) : !askingForGrants && <>
                {dogStirs ? (
                  <WakingDog {...dogLook} size={56} waking />
                ) : phase === "checking" || phase === "starting" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : dogSleeps ? (
                  <SleepingDog {...dogLook} size={56} />
                ) : phase === "local" || phase === "local-unavailable" ? (
                  <Laptop size={22} />
                ) : (
                  <Monitor size={22} />
                )}
                {emptyLine}
              </>}
              {currentTeamComputer && placeActionButton(autoView)}
              {bot.computer === "cloud" && (phase === "unconfigured" || phase === "error") && placeActionButton(cloudView)}
              {(phase === "local" || phase === "local-unavailable") && livePlace !== "cloud" && !askingForGrants && !state.config?.cloudHome && (
                <div className="min-h-[52px]">
                  <CloudTrialOffer className="mt-1" onUse={takeFreeCloud} />
                </div>
              )}
              {askingForGrants && (
                <LocalComputerPermissions
                  dogName={bot.name}
                  host={permissionHost}
                  checklist={desktopPermissions}
                  busy={permissionBusy}
                  onRequest={(permission) => void requestPermission(permission)}
                  onOpenSettings={(permission) => void openPermissionSettings(permission)}
                  onRelaunch={() => void window.laterdog?.relaunch?.()}
                />
              )}
              {phase === "off" && livePlace !== "off" && !state.config?.cloudHome && <CloudTrialOffer onUse={takeFreeCloud} />}
              {(phase === "show-ready-boat" || phase === "show-sleeping-boat" || phase === "show-pending-boat") && (
                <button
                  type="button"
                  onClick={() => updateComputerSelection({ computer: "cloud" })}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-control-hover"
                >
                  {phase === "show-sleeping-boat"
                    ? t("computer.chooseCloudWake")
                    : phase === "show-ready-boat"
                      ? t("computer.chooseCloudOpen")
                      : t("computer.chooseCloudManage")}
                </button>
              )}
              {pending === null && cloudSleeps && !cloudWakeId && placeActionButton(cloudView)}
            </div>
          )}
        </div>
        <p className="mt-2 text-center text-[12px] text-ink-tertiary">{t("computer.screenOf", { name: bot.name })}</p>

        {errorText && !cloudRefused && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}
        {(cloudPreviewReady || currentTeamComputer) && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              <b>{t("computer.needsYou", { name: bot.name })}</b> {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  cloudPreviewReady ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeOver")}
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={controlPending}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control-hover disabled:opacity-50"
              >
                {t("computer.skip")}
              </button>
            </div>
          </div>
        )}
        {phase !== "team-boat" && (bot.computer !== undefined || computerStatusCurrent) && <>
          <LocalScreenPreview />
          {bot.computer === "local" && !askingForGrants && <MacLocalControl />}
        </>}
        <CloudTasksSection botId={profileBot.id} botName={bot.name} />
      </div>
      </div>
    </aside>
  );
}
