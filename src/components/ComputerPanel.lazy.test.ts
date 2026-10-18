// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  boatState: null as string | null,
  provisionError: null as { status: number; message: string } | null,
  posts: [] as string[],
  looks: 0,
  dispatch: vi.fn(),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: () => createElement("div", { "data-live-screen": "" }),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") fixture.posts.push(path.split("?")[0]!);
    if (path.startsWith("/api/bots/scout/computer/provision")) {
      if (fixture.provisionError) throw Object.assign(new Error(fixture.provisionError.message), { status: fixture.provisionError.status });
      fixture.boatState = "ready";
      return { boxId: "bx_23456789", state: "ready" };
    }
    if (path.startsWith("/api/bots/scout/computer/screenshot")) return { png: "FRAME", format: "jpeg" };
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) {
      fixture.looks++;
      return { surface: "cloud", backend: "box", configured: true,
        box: fixture.boatState ? { boxId: "bx_23456789", state: fixture.boatState } : null };
    }
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine], config: { box: { configured: true } } as AppState["config"] } as AppState,
  dispatch: fixture.dispatch,
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot }) })));
  await settle();
};
const text = () => document.body.textContent ?? "";
const spinning = () => document.querySelector(".animate-spin") !== null;
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
const wakeDog = () => document.querySelector<HTMLButtonElement>("[data-wake-dog] button");

beforeAll(() => {
  vi.stubGlobal("laterdog", undefined);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  fixture.posts.length = 0;
  fixture.boatState = null;
  fixture.provisionError = null;
  fixture.looks = 0;
  vi.useRealTimers();
});

describe("Computer panel on Cloud computer", () => {
  it("opening it starts a cloud computer that never started, and shows its screen", async () => {
    await open(makeBot({ computer: "cloud" }));
    await settle();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual(["/api/bots/scout/computer/provision"]);
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
  });

  it("says in plain words when Settings is starting or changing it at the same moment", async () => {
    fixture.provisionError = { status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" };
    await open(makeBot({ computer: "cloud" }));
    await settle();
    expect(text()).toContain("The computer is busy starting or changing. Try again in a moment.");
    expect(text()).not.toMatch(/bot's|being changed/);
  });

  it("opening it wakes a sleeping cloud computer", async () => {
    fixture.boatState = "archived";
    await open(makeBot({ computer: "cloud" }));
    await settle();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual(["/api/bots/scout/computer/provision"]);
  });

  it("boots the cloud computer when a dog with none chosen opens its computer, like Grok Bot", async () => {
    await open(makeBot());
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "cloud" } });
  });

  it("asks for one start when taking the free computer and opening the panel both offer one", async () => {
    await open(makeBot());
    await open(makeBot({ computer: "cloud" }));
    await settle();
    expect(fixture.posts.filter((path) => path.endsWith("/provision"))).toEqual(["/api/bots/scout/computer/provision"]);
    expect(text()).not.toMatch(/being changed|couldn't start/i);
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
  });

  it("while the bot only chats, says its cloud computer starts when a task needs it", async () => {
    await open(makeBot({ computer: "cloud", busy: true }));
    expect(text()).toContain("Scout gets its own cloud computer the first time a task needs one.");
    expect(button("Start it now")).toBeUndefined();
    expect(wakeDog()).toBeNull();
    expect(document.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(fixture.posts).toEqual([]);
  });

  it("starts it once per open, however often the panel draws", async () => {
    await open(makeBot({ computer: "cloud" }));
    await open(makeBot({ computer: "cloud" }));
    await settle();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual(["/api/bots/scout/computer/provision"]);
  });

  it("says the same about a cloud computer this conversation was moved to, without a start button", async () => {
    const moved = { tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>;
    fixture.boatState = "archived";
    await open(makeBot(moved));
    expect(text()).toContain("Scout's cloud computer is asleep. It wakes in a few seconds when Scout needs it.");
    expect(button("Wake it now")).toBeUndefined();
    expect(wakeDog()).toBeNull();
    expect(fixture.posts).toEqual([]);
  });

  it("a conversation moved to a sleeping cloud computer: no spinner or 'using it' while the bot only chats, and no polling once it stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const moved = (busy: boolean) => makeBot({ busy, tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>);
    fixture.boatState = "archived";
    await open(moved(true));
    expect(text()).toContain("Scout's cloud computer is asleep. It wakes in a few seconds when Scout needs it.");
    expect(text()).not.toContain("Your bot is using this computer right now");
    expect(spinning()).toBe(false);

    await open(moved(false));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(text()).toContain("Scout's cloud computer is asleep.");
    const looks = fixture.looks;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(fixture.looks).toBe(looks);
    expect(spinning()).toBe(false);
    expect(fixture.posts).toEqual([]);
  });

  it("offers Wake it now when the wake on opening failed, and one tap wakes it", async () => {
    fixture.boatState = "archived";
    fixture.provisionError = { status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" };
    await open(makeBot({ computer: "cloud" }));
    await settle();
    fixture.provisionError = null;
    fixture.posts.length = 0;
    const wake = button("Wake it now")!;
    expect(wake).toBeDefined();
    flushSync(() => wake.click());
    await settle();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual(["/api/bots/scout/computer/provision"]);
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
  });

  it("still shows the screen of a cloud computer that select_computer moved this conversation to", async () => {
    fixture.boatState = "ready";
    await open(makeBot({ tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>));
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });
});
