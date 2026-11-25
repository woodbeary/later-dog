import { createRoot } from "react-dom/client";
import {
  BotEditorStore,
  initialState,
  type AppState,
  type Bot,
  type Group,
  type Message,
} from "../../src/state/store";
import { StoreChannelContext, type StoreChannel } from "../../src/state/store-channel";
import { ChatView } from "../../src/components/ChatView";
import { GroupView } from "../../src/components/GroupView";
import { BotListItem, botRowProps } from "../../src/components/Sidebar";
import { applySkin } from "../../src/lib/skins";
import { forgetNativeRuns, receiveNativeRun } from "../../src/lib/native-runs-state";
import type { NativeRun } from "../../shared/native-runs";
import type { ActivityKind } from "../../shared/step-words";
import { useWorkPanelOpen } from "../../src/lib/work-panel";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const room = params.get("room") === "1";
applySkin(params.get("dark") === "1" ? "midnight" : "daylight");
const now = Date.now();
let serial = 0;
let run: NativeRun | undefined;
let historyIncomplete = false;
const history = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`,
    parentId: index ? `history-${index - 1}` : null,
    role: index % 2 === 0 ? "user" : "bot",
    kind: "text",
    text:
      index % 2 === 0
        ? `Earlier question ${index + 1}`
        : `Earlier reply ${index + 1}. The notes are ready.`,
    at: now - (count - index) * 4_000,
    ...(index % 2 ? { from: { botId: "scout", name: "Scout", color: "green" } } : {}),
  }));
const dog: Bot = {
  id: "scout",
  threadId: "fixture-chat",
  name: "Scout",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  busy: false,
  activity: "idle",
  work: { kind: "idle" },
  modelSelection: { instanceId: "fixture", model: "fixture" },
  messages: history(Number(params.get("rows") ?? 20)),
};
const group: Group = {
  id: "fixture-room",
  threadId: "fixture-chat",
  name: "The shop",
  memberIds: ["scout"],
  defaultResponder: { kind: "member", botId: "scout" },
  bulletin: "",
  unread: false,
  createdAt: now,
  working: false,
  work: { kind: "idle" },
  messages: dog.messages,
};
let state: AppState = {
  ...initialState,
  bots: [dog],
  groups: [group],
  selectedId: room ? group.id : dog.id,
};
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const change = (patch: Partial<Bot> & { step?: import("../../shared/step-words").LiveStep }) => {
  const next = { ...state.bots[0]!, ...patch };
  state = {
    ...state,
    bots: [next],
    groups: [
      {
        ...state.groups[0]!,
        messages: next.messages,
        working: Boolean(next.busy),
        busyBotId: next.busy ? next.id : null,
        turnStartedAt: next.turnStartedAt,
        work: next.work,
      },
    ],
  };
  emit();
};
const append = (messages: Message[]) => {
  const all = [...state.bots[0]!.messages];
  for (const message of messages) all.push({ ...message, parentId: all.at(-1)?.id ?? null });
  return all;
};
const channel: StoreChannel = {
  read: () => state,
  listen: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  dispatch: () => {},
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
};
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!path.includes("/api/")) return originalFetch(input, init);
  const body = /\/runs\/[^/?]+/.test(path)
    ? { run, activities: [] }
    : /\/runs/.test(path)
      ? { runs: run ? [run] : [], historyIncomplete }
      : /cloud-tasks/.test(path)
        ? { tasks: [] }
        : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function start() {
  const at = Date.now();
  const turnId = `fixture-turn-${++serial}`;
  run = {
    id: turnId,
    turnId,
    threadId: dog.threadId,
    botId: dog.id,
    provider: "fixture",
    providerInstanceId: "fixture",
    revision: 1,
    startedAt: at,
    state: "running",
    observation: "live",
    activityCount: 1,
    failureCount: 0,
    limitations: [],
    actors: [
      {
        id: "parent",
        kind: "parent",
        label: dog.name,
        state: "running",
        startedAt: at,
        model: "Example model",
      },
    ],
    currentActivity: {
      id: `read-${serial}`,
      actorId: "parent",
      kind: "tool",
      label: "Read",
      state: "running",
      startedAt: at,
      subject: "order form",
    },
  };
  receiveNativeRun(run);
  change({
    busy: true,
    activity: "working",
    work: { kind: "running" },
    turnStartedAt: at,
    step: { id: `home-${serial}`, kind: "editing", startedAt: at, lastActivityAt: at },
    messages: append([
      { id: `ask-${serial}`, role: "user", kind: "text", text: "Please check the order form.", at },
    ]),
  });
}
function step(kind: ActivityKind, subject?: string, age = 0) {
  if (!run) throw new Error("Start a turn first");
  const label =
    kind === "reading"
      ? "Read"
      : kind === "editing"
        ? "Edit"
        : kind === "running"
          ? "Bash"
          : kind === "thinking"
            ? "Thinking"
            : "Search";
  run = {
    ...run,
    revision: run.revision + 1,
    currentActivity: {
      id: `step-${++serial}`,
      actorId: "parent",
      kind: kind === "thinking" ? "reasoning" : "tool",
      label,
      state: "running",
      startedAt: Date.now() - age,
      subject,
    },
  };
  receiveNativeRun(run);
}
function land(options: { long?: boolean; count?: number; steps?: boolean } = {}) {
  if (!run) throw new Error("Start a turn first");
  const at = Date.now();
  const text = options.long
    ? Array.from(
        { length: 30 },
        (_, index) =>
          `Paragraph ${index + 1}. The order form is working and these notes explain the result in detail.`,
      ).join("\n\n")
    : "The order form works.\n\nI fixed the address field and checked the result.\n\nYour existing orders are kept.";
  const rows: Message[] = [];
  if (options.steps !== false)
    rows.push({
      id: `work-${serial}`,
      role: "bot",
      kind: "activity",
      tool: { name: "Edit", ok: true },
      turnId: run.turnId,
      at,
    });
  for (let index = 0; index < (options.count ?? 1); index++)
    rows.push({
      id: `reply-${serial}-${index}`,
      role: "bot",
      kind: "text",
      text: index ? `Deliberate separate reply ${index + 1}.` : text,
      turnId: run.turnId,
      turnTerminal: true,
      at: at + index,
      from: { botId: dog.id, name: dog.name, color: dog.color },
    });
  run = {
    ...run,
    revision: run.revision + 1,
    endedAt: at,
    state: "done",
    observation: "complete",
    currentActivity: undefined,
  };
  receiveNativeRun(run);
  change({ busy: false, activity: "idle", work: { kind: "idle" }, messages: append(rows) });
}
function reset(count = 20) {
  forgetNativeRuns();
  run = undefined;
  change({
    busy: false,
    activity: "idle",
    work: { kind: "idle" },
    messages: history(count),
    turnStartedAt: undefined,
  });
}
function switchBusy(sameDog = false) {
  const at = Date.now();
  const threadId = "fixture-other-thread";
  const next = {
    ...state.bots[0]!,
    id: sameDog ? dog.id : "fern",
    threadId,
    name: sameDog ? dog.name : "Fern",
    messages: history(130).map((message) => ({
      ...message,
      id: `other-${message.id}`,
      parentId: message.parentId ? `other-${message.parentId}` : null,
    })),
    busy: true,
    activity: "working" as const,
    work: { kind: "running" as const },
    turnStartedAt: at,
  };
  run = {
    id: "other-run",
    turnId: "other-turn",
    threadId,
    botId: next.id,
    provider: "fixture",
    revision: 1,
    startedAt: at,
    state: "running",
    observation: "live",
    actors: [],
    activityCount: 0,
    failureCount: 0,
    limitations: [],
  };
  receiveNativeRun(run);
  if (room) {
    const nextGroup = {
      ...state.groups[0]!,
      id: sameDog ? group.id : "fixture-other-room",
      threadId,
      name: sameDog ? group.name : "The workshop",
      memberIds: [next.id],
      messages: next.messages,
      working: true,
      busyBotId: next.id,
      turnStartedAt: at,
      work: next.work,
    };
    state = { ...state, selectedId: nextGroup.id, bots: [next], groups: [nextGroup] };
  } else {
    state = { ...state, selectedId: next.id, bots: [next] };
  }
  emit();
}
function roomScope(mode: string) {
  forgetNativeRuns();
  run = undefined;
  historyIncomplete = mode === "history-empty";
  const at = Date.now() - 120_000;
  const waiting = {
    busy: true,
    activity: "waiting-on-you" as const,
    work: { kind: "needs-you" as const, what: "Private approval" },
  };
  const privateDog = {
    ...dog,
    threadId: "fixture-private-chat",
    messages: [],
    ...(mode.endsWith("private-wait") ? waiting : {}),
    ...(mode === "working-private-step"
      ? {
          busy: true,
          activity: "working" as const,
          step: { id: "private-edit", kind: "editing" as const, startedAt: at, lastActivityAt: at },
        }
      : {}),
  };
  const busy = mode.startsWith("working-") || mode === "speaker-selection";
  const other = { ...dog, id: "fern", threadId: "fern-private-chat", name: "Fern", ...waiting };
  const nextGroup: Group = {
    ...group,
    threadId: `fixture-room-scope-${++serial}`,
    messages:
      mode === "working-private-step"
        ? [
            {
              id: "room-read",
              role: "bot",
              kind: "activity",
              at,
              tool: { name: "Read" },
              from: { botId: dog.id, name: dog.name, color: dog.color },
            },
          ]
        : [],
    memberIds: mode === "speaker-selection" ? [dog.id, other.id] : [dog.id],
    working: busy,
    busyBotId: busy && mode !== "speaker-selection" ? dog.id : null,
    turnStartedAt: busy ? at : undefined,
    work:
      mode === "room-wait"
        ? { kind: "needs-you", what: "Room approval" }
        : busy
          ? { kind: "running" }
          : { kind: "idle" },
  };
  state = {
    ...state,
    selectedId: nextGroup.id,
    bots: mode === "speaker-selection" ? [privateDog, other] : [privateDog],
    groups: [nextGroup],
  };
  emit();
}
const fixture = { start, step, land, reset, switchBusy, roomScope, state: () => state };
Object.assign(window, { turnSlotFixture: fixture });

function Preview() {
  const workPanelOpen = useWorkPanelOpen();
  const selected = state.bots[0]!;
  return (
    <BotEditorStore
      value={{
        state,
        dispatch: channel.dispatch,
        flushBotPatches: channel.flushBotPatches,
        refreshInstances: channel.refreshInstances,
        refreshModels: channel.refreshModels,
      }}
    >
      <StoreChannelContext.Provider value={channel}>
        <div
          data-work-panel-layout={workPanelOpen ? "open" : "closed"}
          className="flex h-screen min-w-0 bg-app text-ink"
        >
          <aside data-sidebar className="hidden w-[300px] shrink-0 bg-panel p-2 md:block">
            <BotListItem
              {...botRowProps(state, () => {}, selected, {
                density: "comfortable",
                onMenu: () => {},
              })}
            />
          </aside>
          {room ? <GroupView group={state.groups[0]!} /> : <ChatView bot={selected} />}
        </div>
      </StoreChannelContext.Provider>
    </BotEditorStore>
  );
}
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<Preview />);
listeners.add(render);
render();
