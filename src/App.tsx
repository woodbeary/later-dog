import { useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, StoreProvider, useStore } from "@/state/store";
import { CloudQuietLine } from "@/components/CloudQuietLine";
import { CloudSignInGate, useCloudSignInGate } from "@/components/CloudSignInGate";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { cloudSignInDue, spotlightsQuiet, type WelcomeViewer } from "@/lib/onboarding";
import { FirstConversationTour } from "@/components/onboarding/FirstConversationTour";
import { GuidedTour } from "@/components/onboarding/GuidedTour";
import { LiveCallHost } from "@/components/LiveCallHost";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { LaterDogWorkspace } from "@/components/LaterDogWorkspace";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SIDEBAR_AND_PANEL_FIT, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import {
  ActivityPanel, BotSettingsDialog, CloudTaskPanel, ComputerPanel, InspectorPanel, KeyboardShortcutsModal, NewBotDialog,
  preloadScreens, RemoteAgentSettingsPanel, RemoteDesktopPanel, SettingsModal, TeamMapPage, TriggersPanel,
} from "@/components/lazy-screens";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { CredentialStoreNotice } from "@/components/CredentialStoreNotice";
import { DesktopCapabilitiesProvider, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { NoEngines } from "@/components/NoEngines";
import { LaunchSplash } from "@/components/LaunchSplash";
import { CloudEngineSignIn } from "@/components/CloudEngineSignIn";
import { CloudSetup } from "@/components/CloudSetup";
import { engineReady } from "@/components/EngineLibrary";
import { CommandPalette } from "@/components/CommandPalette";
import { AddAccountHost } from "@/components/AddAccountHost";
import { UpdateDialog } from "@/components/UpdateButton";
import { setLocale } from "@/lib/i18n";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { botShowsUnread } from "@/lib/bot-unread";
import { takePhoneAppRequest } from "@/lib/phone-pairing";
import { PhoneAppDialog } from "@/components/PhoneAppDialog";
import { acknowledgeOrganizationSettings } from "@/lib/organization-settings-ack";

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && botShowsUnread(bot)).length +
    state.groups.filter((group) => group.unread).length;
  const remoteClient = window.laterdog?.remoteClient?.active === true;
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
    if (requestedSettings === "workspaces" || (requestedSettings === "organization" && window.laterdog.organization && !remoteClient) ||
      ((requestedSettings === "cloud" || requestedSettings === "cloud-settings") && window.laterdog.cloudAccount && !remoteClient)) {
      url.searchParams.delete("desktop-settings");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (requestedSettings === "workspaces") open();
      else dispatch(CLOUD_LINK_SETTINGS);
      acknowledgeOrganizationSettings(requestedSettings, window.laterdog.organization, remoteClient);
    }
    return window.laterdog.environments.onOpenSettings?.(open);
  }, [dispatch]);
  const [phoneAppOpen, setPhoneAppOpen] = useState(false);
  useEffect(() => {
    const rest = takePhoneAppRequest(window.location.href);
    if (rest === null) return;
    window.history.replaceState(null, "", rest);
    setPhoneAppOpen(true);
  }, []);
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
  const sidePanelOpen = (Boolean(bot) && (state.settingsOpen || state.computerOpen || state.inspectorOpen || state.activityOpen))
    || (state.computerOpen && state.cloudTaskId !== null);
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;

  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");
  const cloudSignIn = cloudSignInDue(viewer, state, engineReady);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || state.shortcutsOpen) return;
      if (shouldOpenKeyboardShortcuts(e)) {
        e.preventDefault();
        dispatch({ type: "toggleShortcuts", open: true });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "toggleNewBot", open: true });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, state.shortcutsOpen, dispatch]);

  useEffect(() => {
    window.laterdog?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  useEffect(() => preloadScreens(), []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, bot?.threadId, group?.threadId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    return window.laterdog?.onOpenAppSettings?.(section => {
      dispatch(section ? CLOUD_LINK_SETTINGS : { type: "toggleAppSettings", open: true });
      acknowledgeOrganizationSettings(section, window.laterdog?.organization, remoteClient);
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
      <CredentialStoreNotice />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open dog list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "workspace" ? (
        <LaterDogWorkspace conversationId={bot?.threadId} botId={bot?.id} openConversation={(job) => {
          if (job.botId && job.conversationId) dispatch({ type: "switchTask", botId: job.botId, threadId: job.conversationId });
          else if (job.botId) dispatch({ type: "select", id: job.botId });
          dispatch({ type: "showChat" });
        }} />
      ) : state.activeView === "team-map" ? (
        <TeamMapPage />
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
      {state.settingsOpen && bot && (
        remoteClient
          ? <RemoteAgentSettingsPanel bot={bot} overlay={state.computerOpen && !twoSidePanelsFit} />
          : <BotSettingsDialog key={`settings:${bot.id}`} bot={bot} overlay={(state.inspectorOpen || state.computerOpen) && !twoSidePanelsFit} />
      )}
      {state.computerOpen && state.cloudTaskId ? (
        <CloudTaskPanel key={`cloud-task:${state.cloudTaskId}`} jobId={state.cloudTaskId} bot={bot} />
      ) : state.computerOpen && bot && (
        remoteClient ? (
          <RemoteDesktopPanel key={`computer:${bot.id}`} bot={bot} />
        ) : (
          <ComputerPanel key={`computer:${bot.id}`} bot={bot} />
        )
      )}
      {!remoteClient && state.inspectorOpen && bot && <InspectorPanel key={bot.threadId} bot={bot} />}
      {!remoteClient && state.activityOpen && bot && <ActivityPanel key={`activity:${bot.id}`} bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      <PhoneAppDialog
        open={phoneAppOpen}
        onClose={() => setPhoneAppOpen(false)}
      />
      <CloudSetup viewer={viewer} />
      {state.pluginsOpen && <PluginsPanel />}
      {state.triggersOpen && <TriggersPanel />}
      {state.newBotOpen && <NewBotDialog />}
      {state.shortcutsOpen && (
        <KeyboardShortcutsModal
          open={state.shortcutsOpen}
          onClose={() => dispatch({ type: "toggleShortcuts", open: false })}
        />
      )}
      <CommandPalette />
      <AddAccountHost />
      <UpdateDialog />
      </div>
      <CloudQuietLine />
      <WindowCaptionButtons
        visible={capabilities.windowChrome === "win-caption" && Boolean(window.laterdog?.windowControls)}
      />
    </div>
  );
}

function Application() {
  useEffect(() => {
    initAnalytics();
  }, []);
  const viewer = useWelcomeViewer();
  const signInGate = useCloudSignInGate();
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <ThreadRefsProvider>
          <Shell viewer={viewer} />
        </ThreadRefsProvider>
        <WelcomeGate viewer={viewer} hold={signInGate.holding} />
        <CloudSignInGate gate={signInGate} />
        <GuidedTour />
        <LiveCallHost />
        <FirstConversationTour quiet={spotlightsQuiet(viewer)} />
        <LaunchSplash />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

export default function App() {
  return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
