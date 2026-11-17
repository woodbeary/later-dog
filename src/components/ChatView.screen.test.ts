import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const view = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { showToolCalls: true };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: {
      ...original.initialState,
      config: { features: { showToolCalls: view.showToolCalls } },
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo],
    },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const IMAGE = 'src="/api/threads/t1/messages/shot/image"';
const greeting: Message = { id: "hi", role: "bot", kind: "text", text: "Hello", at: 1 };
const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
});
const render = (b: Bot) => renderToStaticMarkup(createElement(ChatView, { bot: b }));

describe("ChatView screenshot", () => {
  it("keeps a look at the screen out of the chat, like every other step, even with the old setting on", () => {
    const markup = render(bot([greeting,
      { id: "shot", role: "bot", kind: "screen", hasImage: true, mime: "image/png", at: 2, parentId: "hi" } as Message]));
    expect(markup).not.toContain(IMAGE);
    expect(markup).toContain("Hello");
  });

  it("shows nothing for a screen message that has no image", () => {
    const markup = render(bot([greeting, { id: "shot", role: "bot", kind: "screen", at: 2, parentId: "hi" } as Message]));
    expect(markup).not.toContain("/messages/shot/image");
  });
});
