// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Helper } from "../../shared/helpers";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ServerFrame } from "../../shared/wire";
import type { AppState, BotAnnouncement } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};
const helper = (id: string, patch: Partial<Helper> = {}): Helper =>
  ({ id, kind: "agent", label: `Helper ${id}`, state: "running", background: true, startedAt: 1, ...patch });

const { StoreProvider, useStore } = await import("./store");
const { currentHelpers, forgetHelpers } = await import("@/lib/helpers-state");
const { forgetReasoning, turnReasoning } = await import("@/lib/turn-reasoning");

let renders = 0;
let seen!: AppState;
function Probe() {
  seen = useStore().state;
  renders++;
  return null;
}
let root: Root | null = null;
let cursor = 0;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const send = async (frame: ServerFrame) => {
  FixtureEventSource.opened.at(-1)!.send(frame, `run:${++cursor}`);
  await settle();
};
const runtime = (event: Record<string, unknown>) =>
  ({ kind: "runtime", event: { provider: "claude", threadId: "thread", createdAt: "2026-10-13T12:00:00.000Z", eventId: `e${cursor}`, turnId: "turn-1", ...event } as RuntimeEvent }) as ServerFrame;

async function mount(helpersAnswer: () => Promise<Response>) {
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    if (path.startsWith("/api/bots?")) return Promise.resolve(new Response(JSON.stringify({ bots: [bot], groups: [] })));
    if (path === "/api/helpers") return helpersAnswer();
    return Promise.resolve(new Response(JSON.stringify(answers[path] ?? {})));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened.at(-1)!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
}

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetHelpers();
  forgetReasoning();
});

describe("helpers in the store", () => {
  it("loads the helpers board with the snapshot and keeps it current from frames, outside app state", async () => {
    await mount(() => Promise.resolve(new Response(JSON.stringify({ helpers: { thread: [helper("one")] } }))));
    expect(seen.bots.map((candidate) => candidate.id)).toEqual(["bot"]);
    expect(currentHelpers().thread?.map((entry) => entry.id)).toEqual(["one"]);

    const before = seen;
    const rendered = renders;
    await send(runtime({ type: "helper.updated", helper: helper("two", { kind: "workflow" }) }));
    await send(runtime({ type: "helper.updated", helper: helper("one", { state: "done", endedAt: 5 }) }));
    await send(runtime({ type: "helper.updated", helper: helper("one", { activity: "late" }) }));
    expect(currentHelpers().thread).toEqual([
      expect.objectContaining({ id: "one", state: "done" }),
      expect.objectContaining({ id: "two", kind: "workflow", state: "running" }),
    ]);
    expect(seen).toBe(before);
    expect(renders).toBe(rendered);
  });

  it("stays quiet and empty when the server has no helpers endpoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount(() => Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 })));
    expect(currentHelpers()).toEqual({});
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("helpers"))).toEqual([]);
    await send(runtime({ type: "helper.updated", helper: helper("one") }));
    expect(currentHelpers().thread?.map((entry) => entry.id)).toEqual(["one"]);
  });

  it("keeps the turn's streamed reasoning for the peek without touching app state", async () => {
    await mount(() => Promise.resolve(new Response(JSON.stringify({ helpers: {} }))));
    const before = seen;
    await send(runtime({ type: "turn.started" }));
    await send(runtime({ type: "content.delta", streamKind: "reasoning_text", delta: "Weighing two options" }));
    await send(runtime({ type: "item.updated", itemType: "reasoning", tokens: 640 }));
    expect(turnReasoning("thread")).toMatchObject({ text: "Weighing two options", streamed: true, tokens: 640 });
    expect(seen.bots).toBe(before.bots);
  });
});
