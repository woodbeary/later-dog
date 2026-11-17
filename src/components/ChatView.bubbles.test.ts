import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const view = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { showToolCalls: false };
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

const at = (n: number) => 1_000 + n;
const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Juniper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: messages.map((message, index) => ({ ...message, parentId: messages[index - 1]?.id })),
  activeLeafId: messages.at(-1)?.id, modelSelection: { instanceId: "test", model: "m" },
});
const render = (messages: Message[]) => renderToStaticMarkup(createElement(ChatView, { bot: bot(messages) }));
const bubbles = (markup: string) => [...markup.matchAll(/<div data-chat-bubble="true" class="([^"]*)"/g)].map((match) => match[1]!);

describe("bubbles in the transcript", () => {
  it("draws the person's bubble neutral with white text and no dog tint, and the dog's on the bubble colour, both at 16/24", () => {
    const markup = render([
      { id: "u", role: "user", kind: "text", text: "Add a pickup time", at: at(1) },
      { id: "b", role: "bot", kind: "text", text: "On it.", at: at(2) },
    ]);
    const [person, dog] = bubbles(markup);
    expect(person).toContain("bg-bubble-user");
    expect(person).toContain("text-white");
    expect(person).toContain("text-[16px] leading-6");
    expect(person).toContain("px-[14px] py-2");
    expect(person).toContain("rounded-[20px]");
    expect(dog).toContain("bg-[var(--color-bubble)]");
    expect(markup).not.toContain("data-dog-tint");
  });

  it("tightens the corners where bubbles from the same side touch", () => {
    const [first, second] = bubbles(render([
      { id: "b1", role: "bot", kind: "text", text: "One", at: at(1) },
      { id: "b2", role: "bot", kind: "text", text: "Two", at: at(2) },
    ]));
    expect(first).toContain("rounded-bl-[8px]");
    expect(first).not.toContain("rounded-tl-[8px]");
    expect(second).toContain("rounded-tl-[8px]");
    expect(second).not.toContain("rounded-bl-[8px]");
  });

  it("puts a message from another dog in the dog's bubble under a From line", () => {
    const markup = render([{ id: "p", role: "user", kind: "text", text: "Can you check the menu?", peerAsk: { name: "Mabel" }, at: at(1) } as Message]);
    const [bubble] = bubbles(markup);
    expect(bubble).not.toContain("bg-bubble-user");
    expect(markup).toMatch(/data-chat-bubble[^>]*>[\s\S]*From Mabel/);
  });

  it("folds only a long message from the person, at 5,000 characters or 60 lines, showing 12 lines", () => {
    const shown = (text: string) => render([{ id: "u", role: "user", kind: "text", text, at: at(1) }]).includes("max-h-[288px]");
    expect(shown("a".repeat(5_000))).toBe(false);
    expect(shown("a".repeat(5_001))).toBe(true);
    expect(shown(Array.from({ length: 60 }, () => "line").join("\n"))).toBe(false);
    expect(shown(Array.from({ length: 61 }, () => "line").join("\n"))).toBe(true);
  });
});
