import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { BotEditorStore, initialState, reducer, type AppState, type Bot, type Group, type Message } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

const HOUR = 3_600_000;
const NOW = Date.now();
let sequence = 0;
const at = () => NOW - HOUR + ++sequence * 60_000;

const dog = (id: string, name: string, color: Bot["color"], extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", notifications: true, color, unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, avatarUrl: null, createdAt: NOW - 2 * HOUR,
  messages: [], ...extra,
} as Bot);

const mochi = dog("mochi", "Mochi", "red");
const tutor = dog("tutor", "Tutor", "blue", { formerNames: ["Study Helper"] });
const scout = dog("scout", "Scout", "green");

const exchange: Group = {
  id: "exchange", threadId: "thread-exchange", name: "Mochi ⇄ Tutor", memberIds: ["mochi", "tutor"], dm: true,
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: NOW - 2 * HOUR, busyBotId: null,
  messages: [
    { id: "x1", role: "bot", kind: "text", at: at(), text: "what color is the sky?", from: { botId: "mochi", name: "Mochi", color: "red" } },
    { id: "x2", role: "bot", kind: "text", at: at(), text: "Blue on a clear day, orange and red at sunset.", from: { botId: "tutor", name: "Study Helper", color: "blue" } },
    { id: "x3", role: "bot", kind: "text", at: at(), text: "thanks, and at night?", from: { botId: "mochi", name: "Mochi", color: "red" } },
    { id: "x4", role: "bot", kind: "text", at: at(), text: "Black, with stars. @Mochi you can quote me.", from: { botId: "tutor", name: "Study Helper", color: "blue" } },
  ],
} as Group;

const comm = (id: string, direction: "to" | "from", name: string, color: Bot["color"], withBotId: string): Message => ({
  id, role: "bot", kind: "activity", at: at(),
  tool: { name: direction === "to" ? `Messaged @${name}` : `Message from @${name}` },
  comm: { groupId: "exchange", withBotId, withName: name, withColor: color, direction },
});

const mochiMessages: Message[] = [
  { id: "m1", role: "bot", kind: "text", at: at(), text: "Hi, I'm Mochi. What would you like me to do?" },
  { id: "m2", role: "user", kind: "text", at: at(), text: "Ask Study Helper what colour the sky is" },
  comm("m3", "to", "Study Helper", "blue", "tutor"),
  { id: "m4", role: "bot", kind: "text", at: at(), text: "I asked. It says blue by day." },
  { id: "m5", role: "user", kind: "text", at: at(), text: "Ask it twice more, @Study Helper knows" },
  comm("m6", "to", "Study Helper", "blue", "tutor"),
  comm("m7", "from", "Study Helper", "blue", "tutor"),
  { id: "m8", role: "bot", kind: "text", at: at(), text: "Done. Both answers are in the exchange." },
  { id: "m9", role: "user", kind: "text", at: at(), text: "Does Scout need to know?" },
  comm("m10", "from", "Scout", "green", "scout"),
  { id: "m11", role: "user", kind: "text", at: at(), text: "can you share the sky notes?", peerAsk: { botId: "scout", name: "Scout" } },
  { id: "m12", role: "bot", kind: "text", at: at(), text: "Sent them over to Scout." },
  {
    id: "m13", role: "bot", kind: "options", at: at(),
    card: {
      title: "Approval needed", subtitle: "Hand the sky notes to Scout", options: ["Allow", "Deny", "Always allow"],
      requestId: "preview-request", tool: "delegate_bot", allowKey: "peer:delegate_bot:scout",
    },
  },
];

const chained = (messages: Message[]): Message[] => messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id ?? null }));

const state: AppState = {
  ...initialState,
  bots: [{ ...mochi, messages: chained(mochiMessages) }, tutor, scout],
  groups: [exchange],
  selectedId: "mochi",
  config: null,
};

function Fixture() {
  const [current, dispatch] = useReducer(reducer, state);
  const bot = current.bots.find((candidate) => candidate.id === "mochi")!;
  const value = {
    state: current, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  } as unknown as Parameters<typeof BotEditorStore>[0]["value"];
  return (
    <BotEditorStore value={value}>
      <main className="flex h-screen flex-col bg-app text-ink">
        <div className="min-h-0 flex-1"><ChatView bot={bot} /></div>
      </main>
    </BotEditorStore>
  );
}

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider>);
