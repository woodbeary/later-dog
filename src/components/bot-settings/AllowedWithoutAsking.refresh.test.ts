// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action, Bot, BotAnnouncement } from "@/state/store";
import type { AlwaysAllowedList } from "../../../shared/lasting-allows";

class FixtureEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Wren", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "claude", model: "claude-haiku-4-5" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const peripherals: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/helpers": { helpers: {} },
  "/api/bots?messages=60": { bots: [{ ...bot, messages: [], activeLeafId: null }], groups: [], botQueuedMessages: {} },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { AllowedWithoutAsking } = await import("./AllowedWithoutAsking");

let dispatch!: Dispatch<Action>;
function Probe() {
  dispatch = useStore().dispatch;
  return null;
}
let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Always allowed list after a grant", () => {
  it("shows the new search as soon as Always allow on a card is saved, without reopening settings", async () => {
    let list: AlwaysAllowedList = { paused: false, items: [] };
    const requests = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/bots/bot/always-allowed") return new Response(JSON.stringify(list));
      if (path === "/api/bots/bot/always-allow" && init?.method === "POST") {
        list = { paused: false, items: [{ id: "search:1", kind: "search", grantedAt: "2026-11-15T12:00:00.000Z", state: "active" }] };
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path === "/api/threads/thread/respond") return new Response(JSON.stringify({ ok: true }));
      if (path.startsWith("/api/bots?")) return new Response(JSON.stringify(peripherals["/api/bots?messages=60"]));
      return new Response(JSON.stringify(peripherals[path] ?? {}));
    });
    vi.stubGlobal("EventSource", FixtureEventSource);
    vi.stubGlobal("fetch", requests);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe), createElement(AllowedWithoutAsking, { bot: bot as unknown as Bot }))));
    await settle();
    expect(container.textContent).toContain("Nothing yet.");

    flushSync(() => dispatch({ type: "decideRequest", threadId: "thread", requestId: "request-1", behavior: "allow", lastingGrant: { botId: "bot" }, scope: "always" }));
    await settle();

    expect(requests.mock.calls.filter(([path]) => path === "/api/bots/bot/always-allowed")).toHaveLength(2);
    expect(container.textContent).toContain("Search for the same words");
    expect(container.textContent).not.toContain("Nothing yet.");
  });
});
