import type { AppState } from "@/state/store";
import { dogIn } from "@/state/store-selectors";
import { cloudSignInDue, type WelcomeViewer } from "@/lib/onboarding";
import { engineReady } from "@/components/EngineLibrary";
import { botShowsUnread } from "@/lib/bot-unread";

export function shellView(state: AppState, viewer: WelcomeViewer | null) {
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (dogIn(state, state.selectedId) ?? state.bots[0]);
  return {
    language: state.config?.language,
    cloudHome: Boolean(state.config?.cloudHome),
    selectedId: state.selectedId,
    groupId: group?.id,
    groupThreadId: group?.threadId,
    botId: bot?.id,
    botThreadId: bot?.threadId,
    computerOpen: state.computerOpen,
    cloudTaskId: state.cloudTaskId,
    settingsOpen: state.settingsOpen,
    routinesOpen: state.routinesOpen,
    appSettingsOpen: state.appSettingsOpen,
    pluginsOpen: state.pluginsOpen,
    newBotOpen: state.newBotOpen,
    shortcutsOpen: state.shortcutsOpen,
    taskView: state.taskView,
    connected: state.connected,
    hydrated: state.hydrated,
    noEngines:
      state.connected &&
      state.instances.length > 0 &&
      !state.instances.some((i) => i.snapshot.state === "available"),
    cloudSignIn: cloudSignInDue(viewer, state, engineReady),
  };
}

export function unreadChats(state: AppState): number {
  return state.bots.filter((dog) => !dog.hidden && botShowsUnread(dog)).length +
    state.groups.filter((room) => room.unread && !room.dm).length;
}
