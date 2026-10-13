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
const { appendComposerDraft } = await import("@/lib/drafts");

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
const scrollAndSelect = async (textarea: HTMLTextAreaElement, start: number, end: number, scrollTop: number) => {
  await act(async () => {
    textarea.setSelectionRange(start, end);
    textarea.scrollTop = scrollTop;
    textarea.dispatchEvent(new Event("scroll"));
  });
};
const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
const place = (textarea: HTMLTextAreaElement) => [textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop];
const longMessage = Array.from({ length: 40 }, (_, line) => `line ${line + 1} of a long message`).join("\n");

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

  it("comes back scrolled to the same spot with the caret where the person left it", async () => {
    const long = await show("thread-long");
    await type(long, longMessage);
    await scrollAndSelect(long, 300, 312, 180);
    await show("thread-short");
    await nextFrame();
    const back = await show("thread-long");
    expect(place(back)).toEqual([300, 312, 180]);
    await nextFrame();
    expect(document.activeElement).toBe(back);
    expect(place(back)).toEqual([300, 312, 180]);
  });

  it("puts the caret at the end of a message that was filled in while the person was away", async () => {
    const long = await show("thread-filled");
    await type(long, longMessage);
    await scrollAndSelect(long, 20, 20, 60);
    await show("thread-elsewhere");
    appendComposerDraft("bot:biscuit:thread-filled", "one more thing");
    const back = await show("thread-filled");
    await nextFrame();
    expect(back.value.endsWith("one more thing")).toBe(true);
    expect([back.selectionStart, back.selectionEnd]).toEqual([back.value.length, back.value.length]);
  });
});
