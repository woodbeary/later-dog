import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "cua-driver-unavailable", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span") }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const message = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "user", kind: "text", text, at: 1_700_000_000_000, ...extra }) as Message;

const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "m" },
});

describe("a message that is not delivered yet", () => {
  it("gets one quiet sending track under its bubble, and a delivered one gets none", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("m1", "delivered words", { sendId: "a" }), message("optimistic-b", "held words", { sendId: "b" })]),
    }));
    expect(markup.match(/data-sending-track/g)).toHaveLength(1);
    expect(markup.indexOf("data-sending-track")).toBeGreaterThan(markup.indexOf("held words"));
    expect(markup).toContain('aria-label="Sending…"');
    expect(markup).toContain("animation-delay:0ms");
  });

  it("says Not sent yet under a message the outbox is holding, and the dog does not look busy", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("optimistic-b", "held words", { sendId: "b", held: true })]),
    }));
    expect(markup).toContain("data-send-held");
    expect(markup).toContain("Not sent yet");
    expect(markup).not.toContain("data-sending-track");
    expect(markup).not.toContain("data-turn-presence");
    expect(markup).not.toContain("Thinking it over");
  });
});

describe("a message sent while the dog is working", () => {
  it("says Sent under the newest one until the dog takes it in", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: { ...bot([message("m1", "first words", { steered: true }), message("m2", "and also this", { steered: true })]), busy: true },
    }));
    expect(markup.match(/data-receipt=/g)).toHaveLength(1);
    expect(markup).toContain('data-receipt="sent"');
    expect(markup.indexOf("data-receipt")).toBeGreaterThan(markup.indexOf("and also this"));
    expect(markup).not.toContain("sent mid-turn");
  });

  it("says Read once the dog takes it in, and keeps saying it after the turn ends", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("m1", "and also this", { steered: true, readAt: 1_700_000_000_500 })]),
    }));
    expect(markup).toContain('data-receipt="read"');
    expect(markup).toContain(">Read</div>");
  });

  it("shows no receipt once the turn ends unread, or under a message sent between turns", () => {
    const unread = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("m1", "and also this", { steered: true })]),
    }));
    const between = renderToStaticMarkup(createElement(ChatView, {
      bot: { ...bot([message("m1", "hello")]), busy: true },
    }));
    expect(unread).not.toContain("data-receipt");
    expect(between).not.toContain("data-receipt");
  });
});
