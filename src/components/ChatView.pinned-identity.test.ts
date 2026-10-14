import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { PinnedBanner } from "./ChatView";

const bot: Bot = {
  id: "host", threadId: "thread", name: "Host", title: "", description: "", color: "blue",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
};
const peers = [{ ...bot, id: "author", name: "Scout" }, { ...bot, id: "replacement", name: "Atlas" }];
const render = (message: Message, bots: Bot[] = peers) => renderToStaticMarkup(createElement(PinnedBanner, {
  bot, bots, pinnedId: message.id, messages: [message], onJump: vi.fn(),
}));

describe("pinned message identity", () => {
  it("resolves bot-authored pins by id after renaming without changing the saved author", () => {
    const message: Message = { id: "m", role: "bot", kind: "text", text: "Plan drafted.", at: 1,
      from: { botId: "author", name: "Atlas", color: "blue" } };
    expect(render(message)).toContain(">Scout</span>");
    expect(render(message)).not.toContain(">Atlas</span>");
    expect(message.from?.name).toBe("Atlas");
  });

  it("resolves a pinned incoming peer message by its stable sender id", () => {
    const message: Message = { id: "m", role: "user", kind: "text", text: "Please check the plan.", at: 1,
      peerAsk: { botId: "author", name: "Atlas" } };
    expect(render(message)).toContain(">Scout</span>");
    expect(render(message, [{ ...peers[0], hidden: true }])).toContain(">Atlas</span>");
    expect(render(message, [])).toContain(">Atlas</span>");
  });

  it("keeps plain incoming messages and missing identities honest", () => {
    expect(render({ id: "m", role: "user", kind: "text", text: "Hello", at: 1 })).toContain(">You</span>");
    expect(render({ id: "m", role: "bot", kind: "text", text: "Hello", at: 1 })).toContain(">Host</span>");
  });
});
