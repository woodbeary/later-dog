// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import type { ExchangeEnd, WireExchange } from "../../shared/room-exchange";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { forgetNativeRuns } = await import("@/lib/native-runs-state");
const { END_STATES, endState } = await import("@/lib/team-block");

const MINUTE = 60_000;
const START = new Date(2026, 10, 14, 9, 0).getTime();
const TURN = "turn-1";
const LEAD = { botId: "lead", name: "Lead", color: "green" as const };

interface Helper { id: string; name: string; status: WireExchange["status"]; repliesAt?: number }
const HELPERS: Helper[] = [
  { id: "h1", name: "Acorn", status: "running" },
  { id: "h2", name: "Birch", status: "completed", repliesAt: 30 },
  { id: "h3", name: "Cedar", status: "completed", repliesAt: 34 },
  { id: "h4", name: "Dune", status: "running" },
  { id: "h5", name: "Elm", status: "completed", repliesAt: 36 },
];
const LATE: Helper = { id: "h6", name: "Fir", status: "completed", repliesAt: 52 };

const record = (helper: Helper, status: WireExchange["status"], endedBy?: ExchangeEnd): WireExchange => ({
  id: `req-${helper.id}`, status, owner: { dog: LEAD.name, person: false }, from: LEAD.name, to: helper.name, request: `Take lane ${helper.name} and open a draft`,
  ...(status === "completed" ? { reply: "Done." } : {}), ...(endedBy ? { endedBy } : {}),
});
const comm = (helper: Helper, direction: "to" | "from") => ({ groupId: `dm-${helper.id}`, threadId: `dm-${helper.id}-t`, withBotId: helper.id, withName: helper.name, withColor: "blue" as const, direction });
const step = (id: string, name: string, at: number, ok: boolean | undefined, turnId = TURN): Message => ({ id, role: "bot", kind: "activity", at, turnId, tool: { name, ...(ok === undefined ? {} : { ok }) } });
const asked = (helper: Helper, at: number, turnId = TURN): Message => step(`ask-${helper.id}-${at}`, "mcp__agents__coordinate_bots", at, true, turnId);
const sent = (helper: Helper, at: number, status: WireExchange["status"] | null, turnId = TURN): Message => ({
  id: `sent-${helper.id}-${at}`, role: "bot", kind: "activity", at, turnId, from: LEAD,
  ...(status ? { handoffId: `req-${helper.id}`, exchange: record(helper, status) } : {}),
  tool: { name: `Sent to ${helper.name}`, ok: true }, comm: comm(helper, "to"),
});
const replied = (helper: Helper, at: number, ok = true, endedBy?: ExchangeEnd): Message => ({
  id: `replied-${helper.id}-${at}`, role: "bot", kind: "activity", at, from: { botId: helper.id, name: helper.name, color: "blue" },
  comm: comm(helper, "from"), roomRequest: { id: `req-${helper.id}`, phase: "result" },
  exchange: record(helper, ok ? "completed" : "failed", endedBy), tool: { name: ok ? `${helper.name} replied` : `${helper.name} couldn't finish`, ok },
});
const you = (id: string, at: number, text: string): Message => ({ id, role: "user", kind: "text", at, text });
const said = (id: string, at: number, text: string, turnId = TURN): Message => ({ id, role: "bot", kind: "text", at, turnId, text, turnTerminal: true });

function morning(): Message[] {
  const first = START + 4 * MINUTE;
  const late = START + 8 * MINUTE;
  return [
    you("open", START, "Hand the open lanes to new dogs."),
    step("prep-1", "mcp__agents__list_bots", START + 30_000, true),
    step("prep-2", "Bash", START + 40_000, true),
    ...HELPERS.flatMap((helper, index) => [asked(helper, first + index * 4_000), sent(helper, first + index * 4_000 + 200, helper.status)]),
    step("work-1", "mcp__agents__run_on_computer", first + 22_000, true),
    you("more", late, "Also give the team view its own lane."),
    said("ok", late + 37_000, "On it."),
    asked(LATE, late + 78_000, "turn-2"), sent(LATE, late + 78_000 + 200, LATE.status, "turn-2"),
    said("report", late + 9 * MINUTE, "Six lanes are out.", "turn-2"),
    ...[...HELPERS, LATE].filter((helper) => helper.repliesAt).map((helper, index) => replied(helper, START + helper.repliesAt! * MINUTE + index * 1000)),
  ];
}

const profile = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(messages: Message[], missing: string[] = []) {
  const chained = messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id ?? null }));
  const helpers = [...HELPERS, LATE, { id: "h7", name: "Gorse", status: "running" as const }].filter((helper) => !missing.includes(helper.id)).map((helper) => profile(helper.id, helper.name));
  const state: AppState = {
    ...initialState, connected: true, selectedId: "lead",
    bots: [profile("lead", "Lead", { messages: chained, activeLeafId: chained.at(-1)!.id }), ...helpers],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: null,
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: state.bots[0]! }) })));
  await settle();
}

const quietRows = () => [...document.querySelectorAll("[data-quiet-line], [data-team-block], [data-failed-results]")];
const blocks = () => [...document.querySelectorAll("[data-team-block]")].map((block) => ({
  heading: block.querySelector("[data-team-heading]")!.textContent,
  rows: [...block.querySelectorAll("[data-team-name]")].map((name) => `${name.textContent}: ${name.parentElement!.querySelector("[data-team-state]")!.textContent}`),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 14, 11, 0));
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  forgetNativeRuns();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a turn's hand-outs as one team block", () => {
  it("shows five asks and their replies as one block that updates in place, and the later ask as its own", async () => {
    await draw(morning());
    expect(quietRows()).toHaveLength(2);
    expect(blocks()).toEqual([
      { heading: "Asked 5 dogs · 3 done", rows: ["Acorn: Working", "Birch: Done", "Cedar: Done", "Dune: Working", "Elm: Done"] },
      { heading: "Asked 1 dog · 1 done", rows: ["Fir: Done"] },
    ]);
  });

  it("gives a late failure its own row at the bottom and says it on the helper's row too", async () => {
    const [a, b] = [HELPERS[1]!, HELPERS[3]!];
    await draw([
      you("open", START, "Ask two dogs."),
      asked(a, START + 20_000), sent(a, START + 20_200, "completed"),
      asked(b, START + 24_000), sent(b, START + 24_200, "running"),
      said("asked", START + 30_000, "Both are on it."),
      replied(a, START + 6 * MINUTE),
      you("again", START + 9 * MINUTE, "What's next?"),
      said("next", START + 9 * MINUTE + 20_000, "The notes.", "turn-2"),
      replied(b, START + 14 * MINUTE, false, "problem"),
    ]);
    expect(blocks()).toEqual([{ heading: "Asked 2 dogs · 1 done", rows: ["Birch: Done", "Dune: Couldn't finish"] }]);
    const last = quietRows().at(-1)!;
    expect(last.matches("[data-failed-results]")).toBe(true);
    expect(last.textContent).toContain("Dune couldn't finish");
  });

  it("counts dogs, not asks, gives an older home's one reply to the latest ask, and says a deleted helper was removed", async () => {
    const [a, gone] = [HELPERS[1]!, { id: "h7", name: "Gorse", status: "running" as const }];
    await draw([
      you("open", START, "Ask Birch twice, then Gorse."),
      asked(a, START + 20_000), sent(a, START + 20_200, null),
      asked(a, START + 22_000), sent(a, START + 22_200, null),
      asked(gone, START + 24_000), sent(gone, START + 24_200, null),
      said("asked", START + 30_000, "Asked both."),
      { id: "heard", role: "bot", kind: "activity", at: START + 5 * MINUTE, from: { botId: a.id, name: a.name, color: "blue" }, comm: comm(a, "from"), tool: { name: `Message from @${a.name}`, ok: true } },
    ], ["h7"]);
    expect(blocks()).toEqual([{ heading: "Asked 2 dogs · 1 done", rows: ["Birch: Sent", "Birch: Done", "Gorse: Removed"] }]);
    expect(quietRows()).toHaveLength(1);
  });

  it("keeps a send to the team that failed as its own line naming who it couldn't reach, before or after a good one", async () => {
    const [a, b] = [HELPERS[0]!, HELPERS[2]!];
    const failed = (at: number): Message => ({ ...step(`fail-${at}`, "mcp__agents__coordinate_bots", at, false), tool: { name: "mcp__agents__coordinate_bots", ok: false, spoken: `checking with ${b.name}` } });
    for (const order of ["after", "before"] as const) {
      const good = [asked(a, START + 20_000), sent(a, START + 20_200, "running")];
      await draw([
        you("open", START, "Ask two dogs."),
        ...(order === "before" ? [failed(START + 10_000), ...good] : [...good, failed(START + 26_000)]),
        said("asked", START + 30_000, "One has it."),
      ]);
      expect(blocks()).toEqual([{ heading: "Asked 1 dog", rows: ["Acorn: Working"] }]);
      const line = document.querySelector("[data-failed-send]");
      expect(line?.textContent).toBe("Couldn't reach Cedar");
      expect(document.querySelector("[data-team-block]")!.textContent).not.toContain("Cedar");
    }
  });

  it("has plain words for every way the home can end a request", () => {
    const ends: ExchangeEnd[] = ["person", "api", "interrupted", "deleted", "idle", "capped", "origin", "limit", "restart", "problem", "timeout", "ceiling"];
    expect(Object.keys(END_STATES).sort()).toEqual([...ends].sort());
    expect(Object.fromEntries(ends.map((end) => [end, endState(end)]))).toEqual({
      person: "Stopped by you", api: "Stopped", interrupted: "Was interrupted", deleted: "Removed",
      idle: "Ran out of time", capped: "Ran out of time", timeout: "Ran out of time", ceiling: "Ran out of time",
      origin: "Never got started", limit: "Stopped at a usage limit", restart: "Stopped when the home restarted", problem: "Couldn't finish",
    });
    expect(endState("something-new")).toBe("Couldn't finish");
  });
});

describe("standing facts about where a chat runs", () => {
  it("leave no row in the chat, since the model line says which account runs it, while a notice that needs the person stays", async () => {
    const moved: Message = { id: "moved", role: "bot", kind: "activity", at: START + 1_000, tool: { name: "notice: Running on Work — Home is recharging, back at 9:00 AM.", ok: true, carry: { from: "home", to: "work" } } };
    const resume: Message = { id: "resume", role: "bot", kind: "activity", at: START + 2_000, tool: { name: "notice: Work stopped partway. Carry on?", ok: true, resume: { handoffId: "h1" } } };
    await draw([you("open", START, "Keep going."), moved, resume, said("done", START + 40_000, "Done.")]);
    expect(document.body.textContent).not.toContain("Running on Work");
    expect(document.querySelector('[data-mid="moved"]')).toBeNull();
    expect(document.querySelector('[data-mid="resume"]')).not.toBeNull();
  });
});

