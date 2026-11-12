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

describe("the home's work state on the row", () => {
  it("names who a busy dog is waiting for instead of plain working dots", () => {
    const facts = dogRowFacts({ ...bot(proxy("answered")), busy: true, work: { kind: "waiting-for-computer", holder: "Patch" } }, {});
    expect(facts.work).toBe("Waiting for the computer while Patch uses it");
  });

  it("shows nothing extra when the home sends no work state", () => {
    expect(dogRowFacts({ ...bot(proxy("answered")), busy: true }, {}).work).toBeNull();
  });

  it("follows the open task's work, not the dog's main chat", () => {
    const base = bot(proxy("answered"));
    const tasked = { ...base, threadId: "task", work: { kind: "idle" as const },
      tasks: [{ threadId: "task", title: "Task", createdAt: 1, work: { kind: "waiting-on-dog" as const, dogs: [{ id: "s", name: "Scout" }] } }] };
    expect(dogRowFacts(tasked, {}).work).toBe("Waiting on Scout");
  });
});
