import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChatHeaderMenu } from "../../src/components/ChatHeaderTasks";
import { SidebarProfileMenu } from "../../src/components/SidebarProfileMenu";
import { BotEditorStore, initialState, reducer, type AppState, type Bot } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const now = Date.now();
const bot: Bot = {
  id: "fixture-dog", threadId: "fixture-main", name: "Olive", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [{ id: "example-message", role: "user", kind: "text", at: now, text: "Example task list" }],
  modelSelection: { instanceId: "fixture", model: "fixture" },
  tasks: Array.from({ length: 20 }, (_, index) => ({
    threadId: `fixture-task-${index + 1}`,
    title: `Example task ${index + 1}`,
    createdAt: now - index,
    openedBy: { botId: "fixture-dog", name: "Olive", at: now - index },
    modelSelection: { instanceId: "fixture", model: "fixture" },
    approvalMode: "full",
    busy: false,
    activity: "idle",
  })),
};
const state: AppState = {
  ...initialState, bots: [bot], groups: [], selectedId: bot.id, connected: true,
  config: { profile: { name: "Example Person" } } as AppState["config"],
};
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  return url.includes("/api/") ? Promise.resolve(Response.json({})) : realFetch(input, init);
};

function MenuPreview() {
  const [current, dispatch] = useReducer(reducer, state);
  const value = { state: current, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return (
    <BotEditorStore value={value}>
      <main data-menu-preview className="relative flex h-screen overflow-hidden bg-app text-ink">
        <aside className="relative w-[320px] shrink-0 border-r border-hairline/40">
          <p className="px-5 py-4 text-sm text-ink-secondary">Example menus</p>
          <div data-profile-preview className="absolute bottom-3 left-3"><SidebarProfileMenu /></div>
        </aside>
        <section className="min-w-0 flex-1">
          <header className="flex h-16 items-center justify-between px-5">
            <span className="text-[15px] font-semibold">{bot.name}</span>
            <ChatHeaderMenu bot={bot} messages={bot.messages} onFind={() => {}} />
          </header>
          <div className="px-5 text-sm text-ink-secondary">Twenty example tasks in the conversation menu.</div>
        </section>
      </main>
    </BotEditorStore>
  );
}

setAnalyticsEnabled(false);
applySkin(params.get("theme") === "dark" ? "midnight" : "daylight");
createRoot(document.getElementById("root")!).render(<MenuPreview />);

