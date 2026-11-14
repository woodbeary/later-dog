import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { BotEditorStore, initialState, reducer, type AppState, type Bot, type Message } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import { failedTurnTool } from "../../shared/failed-turn";
import { helpersStoppedLine } from "../../server/laterdog/helpers-stopped";
import "../../src/styles.css";

const NOW = Date.now();
let sequence = 0;
const at = () => NOW - 3_600_000 + ++sequence * 60_000;

const scout = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, avatarUrl: null, createdAt: NOW - 7_200_000, messages: [],
} as unknown as Bot;

const failure = (id: string, cause: string, flags: Parameters<typeof failedTurnTool>[1] = {}): Message =>
  ({ id, role: "bot", kind: "activity", at: at(), tool: failedTurnTool(cause, { who: "Scout", ...flags }) });

const messages: Message[] = [
  { id: "f1", role: "bot", kind: "text", at: at(), text: "Hi, I'm Scout. What would you like me to do?" },
  { id: "f2", role: "user", kind: "text", at: at(), text: "Please write the release notes." },
  failure("f3", "claude exited 1 before result: Not logged in · Please run /login"),
  failure("f4", helpersStoppedLine({ helpers: 1, commands: 0 })!),
  { id: "f5", role: "bot", kind: "activity", at: at(), tool: { name: "recovery: Scout stopped before finishing, so it is carrying on by itself.", ok: true, pickup: "watch" } },
  { id: "f6", role: "bot", kind: "text", at: at(), text: "The release notes are in notes.md." },
];

const state: AppState = {
  ...initialState,
  bots: [{ ...scout, messages: messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id ?? null })) }],
  selectedId: "scout",
  config: null,
};

function Fixture() {
  const [current, dispatch] = useReducer(reducer, state);
  const value = {
    state: current, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  } as unknown as Parameters<typeof BotEditorStore>[0]["value"];
  return (
    <BotEditorStore value={value}>
      <main className="flex h-screen flex-col bg-app text-ink">
        <div className="min-h-0 flex-1"><ChatView bot={current.bots[0]!} /></div>
      </main>
    </BotEditorStore>
  );
}

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider>);
