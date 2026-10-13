// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: true } }],
      },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

const biscuit = (threadId: string): Bot => ({
  id: "biscuit", threadId, name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: false,
  modelSelection: { instanceId: "claude", model: "claude-fake" },
});

let host: HTMLDivElement;
let root: Root;

const show = async (threadId: string) => {
  await act(async () => root.render(createElement(Composer, { key: threadId, bot: biscuit(threadId) })));
  return host.querySelector("textarea")!;
};
const type = async (textarea: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a half-written message", () => {
  it("waits in its own conversation while the person looks at another", async () => {
    await type(await show("thread-a"), "half a thought");
    const other = await show("thread-b");
    expect(other.value).toBe("");
    await type(other, "something else");
    expect((await show("thread-a")).value).toBe("half a thought");
    expect((await show("thread-b")).value).toBe("something else");
  });
});
