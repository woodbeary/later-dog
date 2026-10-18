// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  snapshot: undefined as undefined | { state: string; authenticated?: boolean },
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: true },
          ...(fixture.snapshot ? { snapshot: fixture.snapshot, models: { default: "claude-fake", options: [] } } : {}) }],
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
const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.snapshot = undefined;
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
  it("sends on Enter with no delivery choice, and the server decides", async () => {
    const bot = await mount(biscuit(true));
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sends()).toEqual([expect.objectContaining({ botId: "biscuit", threadId: bot.threadId, text: "check the tests" })]);
    expect(sends()[0].deliver).toBeUndefined();
    expect(textarea.value).toBe("");
  });

  it("shows one plain Send button and no extra ways to send", async () => {
    await mount(biscuit(true));
    expect(host.querySelector("button[aria-label='Send message']")).not.toBeNull();
    expect(host.querySelector("button[aria-label='More ways to send']")).toBeNull();
    expect(host.querySelector("textarea")!.placeholder).toBe("Message Biscuit");
  });

  it("does nothing on the up arrow in an empty composer", async () => {
    const bot = { ...biscuit(false), threadId: "thread-empty" };
    await act(async () => root.render(createElement(Composer, { bot })));
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});

describe("an account that isn't signed in yet", () => {
  it("opens its sign-in when the message is sent, and keeps the words for after", async () => {
    fixture.snapshot = { state: "available", authenticated: false };
    await mount(biscuit(false));
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sends()).toHaveLength(0);
    expect(document.body.textContent).toContain("Sign in to Claude");
    expect(textarea.value).toBe("check the tests");
  });

  it("sends at once on an account that is signed in", async () => {
    fixture.snapshot = { state: "available", authenticated: true };
    await mount(biscuit(false));
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sends()).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Sign in to Claude");
  });
});
