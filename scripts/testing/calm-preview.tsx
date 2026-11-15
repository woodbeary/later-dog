import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { BotEditorStore, initialState, reducer, type AppState, type Bot, type Message } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin } from "../../src/lib/skins";
import { receiveNativeRun } from "../../src/lib/native-runs-state";
import type { WireExchange } from "../../shared/room-exchange";
import "../../src/styles.css";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const NOW = Date.now();
const START = NOW - 40 * MINUTE;
const TURN = "turn-lanes";

const dog = (id: string, name: string, color: Bot["color"], extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", notifications: true, color, unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, avatarUrl: null, createdAt: NOW - 3 * 60 * MINUTE,
  messages: [], ...extra,
} as Bot);

const LEAD = { botId: "maple", name: "Maple", color: "green" as const };

interface Helper { id: string; name: string; color: Bot["color"]; ask: string; status: WireExchange["status"]; repliesAfter?: number; endedBy?: WireExchange["endedBy"] }

const HELPERS: Helper[] = [
  { id: "pebble", name: "Pebble", color: "orange", ask: "Take the billing page: show the real usage figure next to each account", status: "running" },
  { id: "thistle", name: "Thistle", color: "purple", ask: "Take the account list: one list, and usage for this chat only", status: "completed", repliesAfter: 30 },
  { id: "marlow", name: "Marlow", color: "blue", ask: "Take the dog page: open any of its chats from there", status: "completed", repliesAfter: 34 },
  { id: "fennel", name: "Fennel", color: "pink", ask: "Take the working line: say what is really running right now", status: "running" },
  { id: "quince", name: "Quince", color: "yellow", ask: "Take the turn layout: tidy how a reply is put together", status: "completed", repliesAfter: 36 },
];
const LATE: Helper = { id: "sorrel", name: "Sorrel", color: "red", ask: "Take the team view: a tidy view of dogs working together", status: "completed", repliesAfter: 52 };

const step = (id: string, name: string, at: number, ok: boolean | undefined, spoken?: string, input?: unknown): Message => ({
  id, role: "bot", kind: "activity", at, turnId: TURN,
  tool: { name, itemId: id, ...(ok === undefined ? {} : { ok }), ...(spoken ? { spoken } : {}), ...(input === undefined ? {} : { input: JSON.stringify(input) }) },
});

const record = (helper: Helper, status: WireExchange["status"]): WireExchange => ({
  id: `req-${helper.id}`, status, owner: { dog: LEAD.name, person: false }, from: LEAD.name, to: helper.name, request: helper.ask,
  ...(status === "completed" ? { reply: "Done, a draft is open." } : {}),
  ...(helper.endedBy && (status === "failed" || status === "cancelled") ? { endedBy: helper.endedBy } : {}),
});

const comm = (helper: Helper, direction: "to" | "from") => ({
  groupId: `dm-${helper.id}`, threadId: `dm-thread-${helper.id}`, withBotId: helper.id, withName: helper.name, withColor: helper.color, direction,
});

const asked = (helper: Helper, at: number, ok = true): Message =>
  step(`ask-${helper.id}`, "mcp__agents__coordinate_bots", at, ok, `checking with ${helper.name}`, { bot_ids: [helper.id], message: helper.ask });

const sent = (helper: Helper, at: number, status: WireExchange["status"], withRecord = true): Message => ({
  id: `sent-${helper.id}-${at}`, role: "bot", kind: "activity", at, turnId: TURN, from: LEAD,
  ...(withRecord ? { handoffId: `req-${helper.id}`, exchange: record(helper, status) } : {}),
  tool: { name: `Sent to ${helper.name}`, ok: true },
  comm: comm(helper, "to"),
});

const replied = (helper: Helper, at: number, ok = true, words?: string): Message => ({
  id: `replied-${helper.id}-${at}`, role: "bot", kind: "activity", at, from: { botId: helper.id, name: helper.name, color: helper.color },
  comm: comm(helper, "from"), roomRequest: { id: `req-${helper.id}`, phase: "result" },
  exchange: record(helper, ok ? "completed" : "failed"),
  tool: { name: words ?? (ok ? `${helper.name} replied` : `${helper.name} couldn't finish`), ok },
} as Message);

const you = (id: string, at: number, text: string): Message => ({ id, role: "user", kind: "text", at, text });
const said = (id: string, at: number, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", at, turnId: TURN, text, ...extra });

const PREP: [string, string][] = [
  ["mcp__agents__list_bots", "seeing who is around"],
  ["Bash", "looking at the latest work"],
  ["Write", "writing a lane brief"],
  ["Write", "writing a lane brief"],
  ["mcp__agents__create_bot", "making a new dog"],
];

function handoffs(): Message[] {
  const first = START + 4 * MINUTE;
  const opening = you("open", START, "Hand the open lanes to new dogs, one lane each, and keep me posted.");
  const prep = PREP.map(([name, spoken], index) => step(`prep-${index}`, name, START + 40 * SECOND + index * 10 * SECOND, true, spoken));
  const out = HELPERS.flatMap((helper, index) => [asked(helper, first + index * 4 * SECOND), sent(helper, first + index * 4 * SECOND + 200, helper.status)]);
  const late = START + 8 * MINUTE;
  const second: Message[] = [
    step("work-1", "mcp__agents__run_on_computer", first + 22 * SECOND, true, "running a few commands"),
    you("more", late, "Also give the team view its own lane."),
    said("ok", late + 37 * SECOND, "On it: a new dog for the team view, then I'll check everyone's first steps."),
    step("late-1", "Write", late + 61 * SECOND, true, "writing a lane brief"),
    asked(LATE, late + 78 * SECOND), sent(LATE, late + 78 * SECOND + 200, LATE.status),
    step("late-2", "mcp__agents__run_on_computer", late + 80 * SECOND, true, "running a few commands"),
    step("late-3", "Bash", late + 4 * MINUTE, true, "checking the branch"),
    step("late-4", "mcp__agents__memory_update", late + 4 * MINUTE + 4 * SECOND, true, "making a note"),
    said("report", late + 9 * MINUTE, "Six lanes are out, one dog each. Three are working, three have opened drafts. I'll tell you when each one lands.", { turnTerminal: true }),
  ];
  const replies = [...HELPERS, LATE].filter((helper) => helper.repliesAfter !== undefined)
    .map((helper, index) => replied(helper, START + helper.repliesAfter! * MINUTE + index * 14 * SECOND));
  return [opening, ...prep, ...out, ...second, ...replies];
}

function lateFailure(): Message[] {
  const [a, b] = [HELPERS[1]!, { ...HELPERS[3]!, endedBy: "problem" as const }];
  return [
    you("open", START, "Ask Thistle and Fennel to look at the two pages."),
    asked(a, START + 20 * SECOND), sent(a, START + 20 * SECOND + 200, "completed"),
    asked(b, START + 24 * SECOND), sent(b, START + 24 * SECOND + 200, "failed"),
    said("asked", START + 30 * SECOND, "Both are on it.", { turnTerminal: true }),
    replied(a, START + 6 * MINUTE),
    you("again", START + 9 * MINUTE, "Thanks. What's next?"),
    { ...said("next", START + 9 * MINUTE + 20 * SECOND, "Next I'll check the release notes."), turnId: "turn-next", turnTerminal: true },
    replied(b, START + 14 * MINUTE, false),
  ];
}

function failedSend(): Message[] {
  const [a, b] = [HELPERS[0]!, HELPERS[2]!];
  return [
    you("open", START, "Ask Pebble and Marlow for a quick look."),
    asked(a, START + 20 * SECOND), sent(a, START + 20 * SECOND + 200, "running"),
    step("ask-fail", "mcp__agents__coordinate_bots", START + 26 * SECOND, false, `checking with ${b.name}`, { bot_ids: [b.id], message: b.ask }),
    said("asked", START + 30 * SECOND, "Pebble has it. I couldn't reach Marlow, I'll try again shortly.", { turnTerminal: true }),
  ];
}

function teamEdge(): Message[] {
  const [a, gone, long] = [HELPERS[1]!, { id: "bramble", name: "Bramble", color: "teal" as Bot["color"], ask: "Check the old export path", status: "running" as const }, { id: "longname", name: "Bartholomew the Exceedingly Thorough Release Reviewer", color: "purple" as Bot["color"], ask: "Read every release note twice", status: "running" as const }];
  return [
    you("open", START, "Ask Thistle twice, then Bramble."),
    asked(a, START + 20 * SECOND), sent(a, START + 20 * SECOND + 200, "running", false),
    asked(a, START + 22 * SECOND), sent(a, START + 22 * SECOND + 200, "running", false),
    asked(gone, START + 24 * SECOND), sent(gone, START + 24 * SECOND + 200, "running", false),
    asked(long, START + 26 * SECOND), sent(long, START + 26 * SECOND + 200, "running"),
    said("asked", START + 30 * SECOND, "Asked both.", { turnTerminal: true }),
    { id: "heard", role: "bot", kind: "activity", at: START + 5 * MINUTE, from: { botId: a.id, name: a.name, color: a.color }, comm: comm(a, "from"), tool: { name: `Message from @${a.name}`, ok: true } },
  ];
}

const QUESTIONS = [
  { question: "Which page should the new usage figure go on?", header: "Page", options: [{ label: "Billing" }, { label: "Accounts" }] },
  { question: "How often should it refresh?", header: "Refresh", options: [{ label: "Every minute" }, { label: "When opened" }] },
];

function question(): Message[] {
  return [
    you("open", START, "Add the usage figure where it fits best."),
    said("q-said", START + 30 * SECOND, "Two quick choices before I start."),
    { id: "q-card", role: "bot", kind: "options", at: START + 31 * SECOND, turnId: TURN, card: { title: "Question", options: [], requestId: "req-question", requestType: "question", questionRequest: { version: 1, questions: QUESTIONS } } } as Message,
  ];
}

function choice(): Message[] {
  return [
    you("open", START, "Pick a name for the export."),
    { id: "c-card", role: "bot", kind: "options", at: START + 31 * SECOND, turnId: TURN, card: { title: "Which name?", subtitle: "Pick one, or use Other to type your own.", options: ["usage-export", "accounts-export"], requestId: "req-choice", requestType: "question" } } as Message,
  ];
}

const DUMP = "Model-written historical summary (may be incomplete):\nThe person asked for six lanes.\n\nHistorical excerpts in chronological order\n[111 earlier excerpts omitted]\nAssistant/record: handed out the lanes";

function summary(): Message[] {
  return [
    { id: "sum", role: "bot", kind: "compaction", at: START, compaction: { summary: DUMP, context: "Text meant for the dog only", firstKeptId: "after", foldedThroughId: "before", tokensBefore: 180_000, by: "harness" } },
    you("after", START + MINUTE, "Where are we?"),
    said("where", START + 90 * SECOND, "Six lanes are out; three drafts are open.", { turnTerminal: true }),
  ];
}

function summaryNew(): Message[] {
  return [
    { id: "sum", role: "bot", kind: "compaction", at: START, compaction: { summary: "Earlier work on the six lanes was summarized.", context: "Text meant for the dog only", firstKeptId: "after", foldedThroughId: "before", tokensBefore: 180_000, by: "harness" } },
    you("after", START + MINUTE, "Where are we?"),
    said("where", START + 90 * SECOND, "Six lanes are out; three drafts are open.", { turnTerminal: true }),
  ];
}

function plan(): Message[] {
  return [
    you("open", START, "Carry on with the release."),
    said("on", START + 20 * SECOND, "Carrying on."),
    you("check", NOW - 4 * MINUTE, "And the notes?"),
    step("p-1", "Bash", NOW - 3 * MINUTE, true, "checking the branch"),
  ];
}

function notice(): Message[] {
  return [
    you("open", START, "Keep going on the export."),
    { id: "moved", role: "bot", kind: "activity", at: START + 5 * SECOND, tool: { name: "notice: Running on Work — Home is recharging, back at 9:00 AM.", ok: true, carry: { from: "claude", to: "work" } } },
    said("going", START + 40 * SECOND, "Export is done; the file is in the downloads folder.", { turnTerminal: true }),
  ];
}

function working(): Message[] {
  return [
    you("open", NOW - 3 * MINUTE, "Run the checks and tell me what fails."),
    step("w-1", "Bash", NOW - 170 * SECOND, true, "running the checks"),
    step("w-2", "Read", NOW - 150 * SECOND, true, "reading the log"),
    step("w-3", "mcp__agents__run_on_computer", NOW - 120 * SECOND, false, "running a few commands"),
    step("w-4", "mcp__agents__run_on_computer", NOW - 60 * SECOND, undefined),
  ];
}

interface Scene { messages: Message[]; lead?: Partial<Bot>; config?: AppState["config"]; deleted?: string[]; run?: boolean }

const SCENES: Record<string, () => Scene> = {
  handoffs: () => ({ messages: handoffs() }),
  lateFailure: () => ({ messages: lateFailure() }),
  failedSend: () => ({ messages: failedSend() }),
  teamEdge: () => ({ messages: teamEdge(), deleted: ["bramble"] }),
  question: () => ({ messages: question(), lead: { busy: true, turnStartedAt: START, activity: "waiting-on-you" } as Partial<Bot> }),
  questionTyped: () => ({ messages: question(), lead: { busy: true, turnStartedAt: START, activity: "waiting-on-you" } as Partial<Bot> }),
  choice: () => ({ messages: choice(), lead: { busy: true, turnStartedAt: START, activity: "waiting-on-you" } as Partial<Bot> }),
  summaryOld: () => ({ messages: summary() }),
  summaryNew: () => ({ messages: summaryNew() }),
  plan: () => ({
    messages: plan(),
    lead: { busy: true, turnStartedAt: NOW - 4 * MINUTE, plan: { updatedAt: NOW - 30 * MINUTE, items: [
      { text: "Write the release notes", status: "done" }, { text: "Check the export on a clean install", status: "in_progress" }, { text: "Post the build", status: "pending" },
    ] } },
  }),
  notice: () => ({
    messages: notice(),
    config: { accountBattery: { enabled: true, order: {}, resting: {}, routed: { "thread-maple": { from: "claude", on: "work", model: "claude-sonnet-5" } } } } as unknown as AppState["config"],
  }),
  working: () => ({ messages: working(), lead: { busy: true, turnStartedAt: NOW - 3 * MINUTE }, run: true }),
};

const params = new URLSearchParams(location.search);
const scene = (SCENES[params.get("scene") ?? "handoffs"] ?? SCENES.handoffs!)();
const chained = (messages: Message[]): Message[] => messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id ?? null }));
const helpers = [...HELPERS, LATE, { id: "bramble", name: "Bramble", color: "teal" as Bot["color"] }, { id: "longname", name: "Bartholomew the Exceedingly Thorough Release Reviewer", color: "purple" as Bot["color"] }]
  .filter((helper) => !scene.deleted?.includes(helper.id))
  .map((helper) => dog(helper.id, helper.name, helper.color));

if (scene.run) {
  receiveNativeRun({
    id: "run-1", threadId: "thread-maple", turnId: TURN, botId: "maple", provider: "claudeAgent", revision: 1, startedAt: NOW - 3 * MINUTE,
    state: "running", observation: "live", activityCount: 4, failureCount: 1, limitations: [],
    actors: [{ id: "parent", kind: "parent", label: "Maple", state: "running", startedAt: NOW - 3 * MINUTE }],
    currentActivity: { id: "w-4", actorId: "parent", kind: "tool", label: "mcp__agents__run_on_computer", state: "running" },
  });
}

const instances = [
  { instanceId: "claude", displayName: "Home", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } },
  { instanceId: "work", displayName: "Work", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } },
] as unknown as AppState["instances"];

const state: AppState = {
  ...initialState,
  bots: [dog(LEAD.botId, LEAD.name, LEAD.color, { ...scene.lead, messages: chained(scene.messages) }), ...helpers],
  groups: [],
  instances,
  selectedId: LEAD.botId,
  config: scene.config ?? null,
};

function Fixture() {
  const [current, dispatch] = useReducer(reducer, state);
  const bot = current.bots.find((candidate) => candidate.id === LEAD.botId)!;
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
applySkin(params.get("theme") === "dark" ? "midnight" : "daylight");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider>);
