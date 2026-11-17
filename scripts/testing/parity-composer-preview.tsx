import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer";
import { QuestionCard } from "../../src/components/QuestionCard";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { reloadPlanUsage } from "../../src/components/PlanUsage";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { BotEditorStore, initialState, reducer, type AppState, type Bot, type Message } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { appendComposerDraft } from "../../src/lib/drafts";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const sceneName = params.get("scene") ?? "working";
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const at3pm = new Date();
at3pm.setHours(15, 0, 0, 0);

interface Scene {
  name: string;
  busy?: boolean;
  draft?: string;
  usage?: { weekly: number; fiveHour: number };
  messages?: Message[];
  above?: "question" | "settled";
}

const question: Message = {
  id: "question-1", role: "bot", kind: "options", at: NOW - 60_000,
  card: {
    title: "Otis has a question", subtitle: "", options: [], requestId: "request-question", requestType: "question",
    questionRequest: { version: 1, questions: [{ question: "Which photo should lead the menu?", options: [
      { label: "The lemon tart", description: "Bright, and it's the new dish" },
      { label: "The garden salad", description: "The most colour on the page" },
    ] }] },
  },
};

const permission = (extra: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "permission-1", role: "bot", kind: "options", at: NOW - 30_000,
  card: { title: "Approval needed", subtitle: "pnpm test --filter menu-page", options: ["Allow", "Deny"], tool: "Bash", requestId: "request-permission", allowKey: "Bash", ...extra },
});

const SCENES: Scene[] = [
  { name: "idle" },
  { name: "draft", draft: "Add a pickup time to the order form" },
  { name: "working", busy: true },
  { name: "working-draft", busy: true, draft: "Also check it on a small phone" },
  { name: "usage-weekly-75", usage: { weekly: 76, fiveHour: 20 } },
  { name: "usage-weekly-90", usage: { weekly: 92, fiveHour: 20 } },
  { name: "usage-five-hour", usage: { weekly: 40, fiveHour: 81 } },
  { name: "question", busy: true, above: "question", messages: [question] },
  { name: "permission", busy: true, messages: [permission()] },
  { name: "settled", above: "settled" },
];

const scene = SCENES.find((candidate) => candidate.name === sceneName) ?? SCENES[0]!;

const report = scene.usage ? {
  fetchedAt: new Date(NOW).toISOString(),
  providers: [{
    id: "claude", name: "Home", driver: "claudeAgent", plan: "max", ok: true, error: null, extra: [],
    weekly: { available: true, usedPercent: scene.usage.weekly, remainingPercent: 100 - scene.usage.weekly, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
    fiveHour: { available: true, usedPercent: scene.usage.fiveHour, remainingPercent: 100 - scene.usage.fiveHour, resetsAt: at3pm.toISOString() },
  }],
} : { fetchedAt: new Date(NOW).toISOString(), providers: [] };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/plan-usage")) return Response.json(report);
  if (url.includes("/api/")) return Response.json({});
  return realFetch(input, init);
};
localStorage.clear();

const name = scene.messages || scene.above === "settled" ? "Otis" : "Juniper";
const dog: Bot = {
  id: "dog", threadId: "thread-dog", name, title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, avatarUrl: null, createdAt: NOW - 3 * HOUR,
  messages: scene.messages ?? [], busy: Boolean(scene.busy), ...(scene.busy ? { turnStartedAt: NOW - 3 * 60_000 } : {}),
} as Bot;
if (scene.draft) appendComposerDraft(`bot:${dog.id}:${dog.threadId}`, scene.draft);

const instances = [
  { instanceId: "claude", displayName: "Home", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, capabilities: { queueing: true }, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } },
] as unknown as AppState["instances"];

const state: AppState = { ...initialState, bots: [dog], groups: [], instances, selectedId: dog.id, config: null };

function Fixture() {
  const [current, dispatch] = useReducer(reducer, state);
  const bot = current.bots.find((candidate) => candidate.id === dog.id)!;
  const value = {
    state: current, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  } as unknown as Parameters<typeof BotEditorStore>[0]["value"];
  return (
    <BotEditorStore value={value}>
      <main data-parity-scene={scene.name} className="flex h-screen bg-app text-ink">
        <aside className="h-full w-[320px] shrink-0 border-r border-hairline/40 bg-app" />
        <section className="flex min-w-0 flex-1 flex-col justify-end px-[55px] pb-[9px]">
          {scene.above === "question" && <div className="px-5"><QuestionCard threadId={bot.threadId} bot={{ name: bot.name }} message={question} /></div>}
          {scene.above === "settled" && (
            <div className="mb-4 px-6">
              <ApprovalCard bot={{ name: bot.name }} threadId={bot.threadId} message={permission({ answered: "allow", answerScope: "once" })} />
            </div>
          )}
          <Composer bot={bot} />
        </section>
      </main>
    </BotEditorStore>
  );
}

setAnalyticsEnabled(false);
applySkin(params.get("theme") === "dark" ? "midnight" : "daylight");
void reloadPlanUsage(true).finally(() => {
  createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider>);
});

