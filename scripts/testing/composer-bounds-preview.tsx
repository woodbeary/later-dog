import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import {
  BotEditorStore,
  initialState,
  reducer,
  type AppState,
  type Bot,
} from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { appendComposerDraft } from "../../src/lib/drafts";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const modelLabel = params.has("long")
  ? "Example model with a longer name for detailed work"
  : "Sonnet 5";
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/plan-usage"))
    return Response.json({ fetchedAt: new Date().toISOString(), providers: [] });
  if (url.includes("/api/")) return Response.json({});
  return realFetch(input, init);
};
localStorage.clear();

const dog = {
  id: "example-dog",
  threadId: "example-thread",
  name: "Example dog",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  avatarUrl: null,
  createdAt: Date.now(),
  modelSelection: { instanceId: "example-account", model: "claude-sonnet-5" },
  messages: [],
  busy: false,
} as Bot;
const instances = [
  {
    instanceId: "example-account",
    displayName: "Example account",
    driverKind: "claudeAgent",
    snapshot: { state: "available", authenticated: true },
    capabilities: { queueing: true },
    models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: modelLabel }] },
  },
] as unknown as AppState["instances"];
const state: AppState = {
  ...initialState,
  bots: [dog],
  groups: [],
  instances,
  selectedId: dog.id,
  config: null,
};
appendComposerDraft(`bot:${dog.id}:${dog.threadId}`, "Please read this");

function Fixture() {
  const [current, dispatch] = useReducer(reducer, state);
  const bot = current.bots.find((candidate) => candidate.id === dog.id)!;
  const value = {
    state: current,
    dispatch,
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  } as unknown as Parameters<typeof BotEditorStore>[0]["value"];
  return (
    <BotEditorStore value={value}>
      <main
        data-composer-bounds-preview
        data-model-label={modelLabel}
        className="flex h-screen bg-app text-ink"
      >
        <aside className="hidden h-full w-[320px] shrink-0 border-r border-hairline/40 bg-app md:block" />
        <section className="flex min-w-0 flex-1 flex-col justify-end px-3 pb-[9px] md:px-[55px]">
          <Composer bot={bot} />
        </section>
      </main>
    </BotEditorStore>
  );
}

setAnalyticsEnabled(false);
applySkin(params.get("theme") === "dark" ? "midnight" : "daylight");
createRoot(document.getElementById("root")!).render(
  <DesktopCapabilitiesProvider>
    <Fixture />
  </DesktopCapabilitiesProvider>,
);
