import { describe, expect, it } from "vitest";
import { dogRowFacts } from "./dog-row";
import type { Bot, Message } from "@/state/store";

const proxy = (status: "waiting" | "answered" | "dismissed"): Message => ({
  id: `proxy-${status}`,
  role: "bot",
  kind: "text",
  at: 1,
  needsYou: { botId: "kennel", botName: "Kennel", threadId: "kennel-thread", messageId: "sign-in", label: "Sign in to Cloudflare", status },
});

const bot = (message: Message): Bot => ({
  id: "clover",
  threadId: "clover-thread",
  name: "Clover",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  busy: false,
  activity: "idle",
  messages: [message],
  modelSelection: { instanceId: "test", model: "test" },
});

describe("delegated Needs you attention", () => {
  it("keeps waiting proxy cards in the Needs you state after the delegating turn ends", () => {
    expect(dogRowFacts(bot(proxy("waiting")), {}).waiting).toBe(true);
  });

  it.each(["answered", "dismissed"] as const)("clears the Needs you state when the source card is %s", (status) => {
    expect(dogRowFacts(bot(proxy(status)), {}).waiting).toBe(false);
  });
});
