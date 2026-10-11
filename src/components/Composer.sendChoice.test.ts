// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  canSteer: true,
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: fixture.canSteer } }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { appendComposerDraft } = await import("@/lib/drafts");
const { setLocale } = await import("@/lib/i18n");

const biscuit = (busy: boolean): Bot => ({
  id: "biscuit", threadId: "thread-1", name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy,
  modelSelection: { instanceId: "claude", model: "claude-fake" },
});

let host: HTMLDivElement;
let root: Root;
let draft = 0;

const mount = async (bot: Bot) => {
  draft += 1;
  const withThread = { ...bot, threadId: `thread-${draft}` };
  appendComposerDraft(`bot:${withThread.id}:${withThread.threadId}`, "check the tests");
  await act(async () => root.render(createElement(Composer, { bot: withThread })));
  return withThread;
};
const chevron = () => host.querySelector<HTMLButtonElement>("button[aria-label='More ways to send']");
const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.canSteer = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the composer while a dog works", () => {
  it("sends the words the way the person picked", async () => {
    const bot = await mount(biscuit(true));
    expect(chevron()).not.toBeNull();
    await act(async () => chevron()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>("[data-delivery=queue]")!.click());
    expect(sends()).toEqual([expect.objectContaining({ botId: "biscuit", threadId: bot.threadId, text: "check the tests", deliver: "queue" })]);
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    expect(chevron()).toBeNull();
  });

  it("keeps Enter as it was: no choice sent, the server decides", async () => {
    await mount(biscuit(true));
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sends()).toHaveLength(1);
    expect(sends()[0].deliver).toBeUndefined();
  });

  it("offers no Steer where the engine can only queue", async () => {
    fixture.canSteer = false;
    await mount(biscuit(true));
    await act(async () => chevron()!.click());
    expect([...host.querySelectorAll<HTMLElement>("[role=menuitem]")].map((item) => item.dataset.delivery)).toEqual(["queue", "stop"]);
  });

  it("has nothing extra to offer while the dog is idle", async () => {
    await mount(biscuit(false));
    expect(host.querySelector("button[aria-label='Send message']")).not.toBeNull();
    expect(chevron()).toBeNull();
  });
});
