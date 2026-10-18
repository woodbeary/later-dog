import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, ConfigStatus, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as ConfigStatus | null, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { Transcript } from "./GroupView";

const members = [
  { id: "maya", name: "Maya" },
  { id: "theo", name: "Theo" },
] as Bot[];
const room = (defaultResponder: Group["defaultResponder"]) => ({ id: "room", defaultResponder } as Group);
const jev = (enabled: boolean): ConfigStatus => ({ decider: { provider: "jev", configured: enabled, enabled, jobs: { roomRouting: true } } } as ConfigStatus);

beforeEach(() => {
  fixture.config = jev(true);
  fixture.dispatch.mockReset();
});

describe("a reply the decision model routed", () => {
  it("reads like any other reply, with no routing label or percentage", () => {
    const reply = (id: string, extra: Partial<Message> = {}): Message =>
      ({ id, role: "bot", kind: "text", text: `reply ${id}`, at: 1_000, from: { botId: "theo", name: "Theo", color: "green" }, ...extra });
    const messages = [reply("routed", { routedBy: { provider: "jev", probability: 0.94 } }), reply("plain", { at: 2_000 })];
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(createElement(Transcript, {
      group: { ...room({ kind: "auto" }), threadId: "thread", messages } as Group, members, locale: "en",
      messages, transcript: messages, onReply: () => undefined,
    }));
    expect(markup).toContain("reply routed");
    expect(markup).not.toContain("Picked by Jev");
    expect(markup).not.toContain("94%");
    vi.unstubAllGlobals();
  });
});
