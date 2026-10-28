import { useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, LENDING_SETTINGS, StoreProvider, useStore } from "@/state/store";
import { CloudQuietLine } from "@/components/CloudQuietLine";
import { CloudSignInGate, useCloudSignInGate } from "@/components/CloudSignInGate";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { cloudSignInDue, type WelcomeViewer } from "@/lib/onboarding";
import { LiveCallHost } from "@/components/LiveCallHost";
import { initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
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
import { engineReady } from "@/components/EngineLibrary";
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
import { botShowsUnread } from "@/lib/bot-unread";
import { acknowledgeOrganizationSettings } from "@/lib/organization-settings-ack";
import { useTimeZoneSync } from "@/lib/time-zone-sync";

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && botShowsUnread(bot)).length +
    state.groups.filter((group) => group.unread && !group.dm).length;
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
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  const [, setLocaleEpoch] = useState(0);
  useEffect(() => {
    setLocale(language || globalThis.navigator?.language);
    setLocaleEpoch((epoch) => epoch + 1);
  }, [language]);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const cloudTaskOpen = state.computerOpen && state.cloudTaskId !== null;
  const sidePanelOpen = (Boolean(bot) && state.settingsOpen) || cloudTaskOpen;
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;
  const calendarFocus = state.routinesOpen;

  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");
  const cloudSignIn = cloudSignInDue(viewer, state, engineReady);

  const history = useRef<SelectionHistory>(EMPTY_HISTORY);
  useEffect(() => {
    history.current = visitSelection(history.current, state.selectedId);
  }, [state.selectedId]);

  useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
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
  }, [state.bots, state.groups, state.selectedId, state.shortcutsOpen, dispatch]);

  useEffect(() => {
    window.laterdog?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  useEffect(() => preloadScreens(), []);

  useTimeZoneSync(state.connected ? (state.config?.cloudHome ? "cloud" : "local") : null);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, bot?.threadId, group?.threadId, state.pluginsOpen, state.settingsOpen]);

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
      ) : cloudSignIn ? (
        <CloudEngineSignIn />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
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
      {state.settingsOpen && bot && !calendarFocus && (
        <BotSettingsDialog key={`settings:${bot.id}`} bot={bot} overlay={cloudTaskOpen && !twoSidePanelsFit} />
      )}
      {cloudTaskOpen && state.cloudTaskId && (
        <CloudTaskPanel key={`cloud-task:${state.cloudTaskId}`} jobId={state.cloudTaskId} bot={bot} />
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

