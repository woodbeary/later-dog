import { describe, expect, it } from "vitest";
import { dogRowFacts } from "./dog-row";
import { helpersLine, stepPhrase } from "../../shared/step-words";
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

describe("the row's one dot and its step words", () => {
  const quiet = bot(proxy("answered"));
  const step = { id: "run-1:tool-7", kind: "running" as const, startedAt: 1, lastActivityAt: 2 };

  it("says the same step phrase as the chat line while the dog works", () => {
    const facts = dogRowFacts({ ...quiet, busy: true, activity: "working", step } as Bot, {});
    expect(facts.step).toBe(stepPhrase(step.kind, step.id));
    expect(facts.dot).toBe("working");
  });

  it("follows the open task's step, not the dog's main chat", () => {
    const taskStep = { ...step, id: "task-run:read-1", kind: "reading" as const };
    const tasked = { ...quiet, threadId: "task", step, tasks: [{ threadId: "task", title: "Task", createdAt: 1, busy: true, step: taskStep }] } as unknown as Bot;
    expect(dogRowFacts(tasked, {}).step).toBe(stepPhrase("reading", taskStep.id));
  });

  it("says Working on it while the home has not sent a step yet", () => {
    expect(dogRowFacts({ ...quiet, busy: true }, {}).step).toBe("Working on it");
  });

  it("has no step words when the dog is still", () => {
    expect(dogRowFacts({ ...quiet, step } as Bot, {}).step).toBeNull();
  });

  it("keeps the green dot while only the dog's helpers or side jobs work", () => {
    const facts = dogRowFacts({ ...quiet, waitingForTeammates: true, waitingOn: [{ botId: "otis", name: "Otis", state: "running" }] }, {});
    expect(facts.dot).toBe("working");
    expect(facts.helperAsk).toBeNull();
  });

  it("names the helper that needs your answer", () => {
    const facts = dogRowFacts({ ...quiet, waitingForTeammates: true, waitingOn: [{ botId: "otis", name: "Otis", state: "needsYou" }] }, {});
    expect(facts.helperAsk).toBe(helpersLine([{ name: "Otis", state: "needsYou" }])!.text);
    expect(facts.dot).toBe("working");
  });

  it("shows amber over green, and blue only for a still dog", () => {
    expect(dogRowFacts(bot(proxy("waiting")), {}).dot).toBe("waiting");
    expect(dogRowFacts({ ...quiet, unread: true }, {}).dot).toBe("unread");
    expect(dogRowFacts({ ...quiet, unread: true, busy: true }, {}).dot).toBe("working");
    expect(dogRowFacts(quiet, {}).dot).toBeNull();
  });
});
