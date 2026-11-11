import { useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, LENDING_SETTINGS, StoreProvider } from "@/state/store";
import { shellView, unreadChats } from "@/state/shell-view";
import { dogIn, sameFields, useStoreDispatch, useStoreReader, useStoreSelector } from "@/state/store-selectors";
import { CloudQuietLine } from "@/components/CloudQuietLine";
import { CloudSignInGate, useCloudSignInGate } from "@/components/CloudSignInGate";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { type WelcomeViewer } from "@/lib/onboarding";
import { LiveCallHost } from "@/components/LiveCallHost";
import { initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { TaskChat } from "@/components/TaskChat";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SIDEBAR_AND_PANEL_FIT, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import {
  BotSettingsDialog, CloudTaskPanel, KeyboardShortcutsModal, NewChatPicker, preloadScreens, RoutinesPage, SettingsModal,
} from "@/components/lazy-screens";
import { CredentialStoreNotice } from "@/components/CredentialStoreNotice";
import { DamagedDataNotice } from "@/components/DamagedDataNotice";
import { DesktopCapabilitiesProvider, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { NoEngines } from "@/components/NoEngines";
import { LaunchSplash } from "@/components/LaunchSplash";
import { CloudEngineSignIn } from "@/components/CloudEngineSignIn";
import { CommandPalette } from "@/components/CommandPalette";
import { AddAccountHost } from "@/components/AddAccountHost";
import { AppLinkHost } from "@/components/AppLinkHost";
import { UpdateDialog } from "@/components/UpdateButton";
import { setLocale } from "@/lib/i18n";
import { isMacPlatform, shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { appShortcut, EMPTY_HISTORY, moveInHistory, stepThrough, visitSelection, type SelectionHistory } from "@/lib/app-shortcuts";
import { sidebarOrder } from "@/lib/sidebar-order";
import { loadSidebarDensity, setSidebarDensity } from "@/lib/sidebar-preferences";
import { isLiveCallRunning, liveCallShortcut, liveMedia } from "@/lib/live-call-media";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { acknowledgeOrganizationSettings } from "@/lib/organization-settings-ack";
import { useTimeZoneSync } from "@/lib/time-zone-sync";

function UnreadCountBadge() {
  const unreadCount = useStoreSelector(unreadChats);
  useEffect(() => {
    window.laterdog?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);
  return null;
}

function OpenRoom({ groupId }: { groupId: string }) {
  const group = useStoreSelector((state) => state.groups.find((g) => g.id === groupId));
  return group ? <GroupView key={group.id} group={group} /> : null;
}

function OpenDog({ botId }: { botId: string }) {
  const bot = useStoreSelector((state) => dogIn(state, botId));
  return bot ? <ChatView bot={bot} /> : null;
}

function OpenDogSettings({ botId, overlay }: { botId: string; overlay: boolean }) {
  const bot = useStoreSelector((state) => dogIn(state, botId));
  return bot ? <BotSettingsDialog bot={bot} overlay={overlay} /> : null;
}

function OpenCloudTask({ jobId, botId }: { jobId: string; botId: string | undefined }) {
  const bot = useStoreSelector((state) => (botId ? dogIn(state, botId) : undefined));
  return <CloudTaskPanel jobId={jobId} bot={bot} />;
}

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const dispatch = useStoreDispatch();
  const readStore = useStoreReader();
  const state = useStoreSelector((store) => shellView(store, viewer), sameFields);
  const { capabilities } = useDesktopCapabilities();
  const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
  const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
  useEffect(() => {
    if (!window.laterdog?.environments) return;
    const open = (computerId?: string | null, panel?: "copy") => {
      if (computerId) {
        const target = new URL(window.location.href);
        target.searchParams.set(panel === "copy" ? "copy-to" : "share-computer", computerId);
        window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
      }
      dispatch({ type: "toggleAppSettings", open: true, section: "computer" });
    };
    const url = new URL(window.location.href);
    const requestedSettings = url.searchParams.get("desktop-settings");
    if (requestedSettings === "workspaces" || (requestedSettings === "organization" && window.laterdog.organization) ||
      ((requestedSettings === "cloud" || requestedSettings === "cloud-settings" || requestedSettings === "lending") && window.laterdog.cloudAccount)) {
      url.searchParams.delete("desktop-settings");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (requestedSettings === "workspaces") open();
      else dispatch(requestedSettings === "lending" ? LENDING_SETTINGS : CLOUD_LINK_SETTINGS);
      acknowledgeOrganizationSettings(requestedSettings, window.laterdog.organization);
    }
    return window.laterdog.environments.onOpenSettings?.(open);
  }, [dispatch]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const language = effectiveLanguage(useLanguageChoice(), state.language);
  const [, setLocaleEpoch] = useState(0);
  useEffect(() => {
    setLocale(language || globalThis.navigator?.language);
    setLocaleEpoch((epoch) => epoch + 1);
  }, [language]);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const { groupId, botId } = state;
  const cloudTaskOpen = state.computerOpen && state.cloudTaskId !== null;
  const sidePanelOpen = (Boolean(botId) && state.settingsOpen) || cloudTaskOpen;
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;
  const calendarFocus = state.routinesOpen;

  const { noEngines, cloudSignIn } = state;

  const history = useRef<SelectionHistory>(EMPTY_HISTORY);
  useEffect(() => {
    history.current = visitSelection(history.current, state.selectedId);
  }, [state.selectedId]);

  useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      const state = readStore();
      if (e.defaultPrevented || e.isComposing || state.shortcutsOpen) return;
      if (shouldOpenKeyboardShortcuts(e)) {
        e.preventDefault();
        dispatch({ type: "toggleShortcuts", open: true });
        return;
      }
      const shortcut = appShortcut(e, isMac);
      if (!shortcut) return;
      if (shortcut.kind === "connectApps" && liveCallShortcut(e, isMac) && isLiveCallRunning(liveMedia().phase)) return;
      const exists = (id: string) => state.bots.some((b) => b.id === id) || state.groups.some((g) => g.id === id && !g.dm);
      const go = (id: string | undefined) => {
        if (!id) return;
        e.preventDefault();
        dispatch({ type: "select", id });
      };
      switch (shortcut.kind) {
        case "search":
          e.preventDefault();
          dispatch({ type: "toggleSearch" });
          return;
        case "newDog":
          e.preventDefault();
          dispatch({ type: "toggleNewBot", open: true });
          return;
        case "settings":
          e.preventDefault();
          dispatch({ type: "toggleAppSettings", open: true });
          return;
        case "connectApps":
          e.preventDefault();
          dispatch({ type: "togglePlugins", open: true, surface: "apps" });
          return;
        case "focusComposer": {
          const composer = document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea');
          if (!composer) return;
          e.preventDefault();
          composer.focus();
          return;
        }
        case "toggleSidebar":
          e.preventDefault();
          setSidebarDensity(loadSidebarDensity() === "icons" ? "comfortable" : "icons");
          return;
        case "dogPanel":
          if (!state.bots.some((b) => b.id === state.selectedId)) return;
          e.preventDefault();
          dispatch({ type: "toggleSettings" });
          return;
        case "back":
        case "forward": {
          const moved = moveInHistory(history.current, shortcut.kind === "back" ? -1 : 1, exists);
          if (!moved) return;
          history.current = moved.history;
          go(moved.id);
          return;
        }
        case "previousDog":
        case "nextDog":
          go(stepThrough(sidebarOrder(), state.selectedId, shortcut.kind === "nextDog" ? 1 : -1));
          return;
        case "dogAt":
          go(sidebarOrder()[shortcut.index]);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readStore, dispatch]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  useEffect(() => preloadScreens(), []);

  useTimeZoneSync(state.connected ? (state.cloudHome ? "cloud" : "local") : null);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.botThreadId, state.groupThreadId, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    return window.laterdog?.onOpenAppSettings?.(section => {
      dispatch(section === "lending" ? LENDING_SETTINGS : section ? CLOUD_LINK_SETTINGS : { type: "toggleAppSettings", open: true });
      acknowledgeOrganizationSettings(section, window.laterdog?.organization);
    });
  }, [dispatch]);

  useEffect(() => {
    return window.laterdog?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId || viewer.contextId.startsWith("cloud-task:")) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  return (
    <div className="flex h-full flex-col">
      <UnreadCountBadge />
      <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex w-[300px] max-w-[calc(100vw-2rem)] flex-col gap-2 [&>*]:pointer-events-auto">
        <CredentialStoreNotice />
        <DamagedDataNotice />
      </div>
      <div className="relative flex min-h-0 flex-1">
      {!calendarFocus && <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open dog list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>}
      {drawerOpen && !calendarFocus && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      {!calendarFocus && <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />}
      {calendarFocus ? (
        <RoutinesPage onBack={() => dispatch({ type: "closeRoutines" })} onOpenRoom={(id) => dispatch({ type: "select", id })} />
      ) : state.taskView ? (
        <TaskChat view={state.taskView} />
      ) : cloudSignIn ? (
        <CloudEngineSignIn />
      ) : noEngines ? (
        <NoEngines />
      ) : groupId ? (
        <OpenRoom groupId={groupId} />
      ) : botId ? (
        <OpenDog botId={botId} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          {!state.connected ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[14px]">{import.meta.env.DEV ? "Connecting to the later.dog server…" : "Starting later.dog…"}</div>
              {import.meta.env.DEV && (
                <div className="text-[12px]">
                  Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
                </div>
              )}
            </>
          ) : state.hydrated ? (
            <div className="text-[14px]">No dogs yet</div>
          ) : null}
        </main>
      )}
      {state.settingsOpen && botId && !calendarFocus && (
        <OpenDogSettings key={`settings:${botId}`} botId={botId} overlay={cloudTaskOpen && !twoSidePanelsFit} />
      )}
      {cloudTaskOpen && state.cloudTaskId && (
        <OpenCloudTask key={`cloud-task:${state.cloudTaskId}`} jobId={state.cloudTaskId} botId={botId} />
      )}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      {state.newBotOpen && <NewChatPicker />}
      {state.shortcutsOpen && (
        <KeyboardShortcutsModal
          open={state.shortcutsOpen}
          onClose={() => dispatch({ type: "toggleShortcuts", open: false })}
        />
      )}
      <CommandPalette />
      <AddAccountHost />
      <AppLinkHost />
      <UpdateDialog />
      </div>
      <CloudQuietLine />
      <WindowCaptionButtons
        visible={capabilities.windowChrome === "win-caption" && Boolean(window.laterdog?.windowControls)}
      />
    </div>
  );
}

export default function App() {
  useEffect(() => {
    initAnalytics();
  }, []);
  const viewer = useWelcomeViewer();
  const signInGate = useCloudSignInGate();
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell viewer={viewer} />
        <WelcomeGate viewer={viewer} hold={signInGate.holding} />
        <CloudSignInGate gate={signInGate} />
        <LiveCallHost />
        <LaunchSplash />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

