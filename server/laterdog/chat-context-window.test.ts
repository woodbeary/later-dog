import { describe, expect, it } from "vitest";
import { compactBudget, contextWindowFor, shouldCompact } from "../context-budget.ts";
import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { toWireTask, type TaskRecord } from "../store.ts";
import { chatContext } from "./chat-context-window.ts";

const FABLE = { instanceId: "claude", model: "claude-fable-5-2" };
const SONNET = { instanceId: "claude", model: "claude-sonnet-5" };

function savedChat(context: NonNullable<TaskRecord["usage"]>["context"], model: typeof FABLE, lastContextModel = `${model.instanceId}:${model.model}`): TaskRecord {
  return {
    id: "task", threadId: "thread", title: "Older chat", createdAt: 0, updatedAt: 0, resumeCursors: {}, modelSelection: model, lastContextModel,
    usage: { input: 0, output: 0, costUsd: null, turns: 1, context },
  } as unknown as TaskRecord;
}

function homeWindow(task: TaskRecord, model: string) {
  return contextWindowFor(model, STATIC_CLAUDE_MODELS, chatContext(task, model)?.window);
}

function homeCompacts(task: TaskRecord, model: string) {
  const window = homeWindow(task, model);
  return shouldCompact({ contextTokens: chatContext(task, model)?.tokens, estimatedBytes: 0, budget: compactBudget(window), window });
}

describe("a chat's context window", () => {
  it("does not fold an older chat at a saved 200K window when its model holds more", () => {
    const task = savedChat({ tokens: 202_712, window: 200_000 }, FABLE);
    expect(homeWindow(task, FABLE.model)).toBe(1_000_000);
    expect(homeCompacts(task, FABLE.model)).toBe(false);
  });

  it("gives the apps and compaction the same number", () => {
    for (const task of [
      savedChat({ tokens: 202_712, window: 200_000 }, FABLE),
      savedChat({ tokens: 202_712, window: 200_000 }, FABLE, ""),
      savedChat({ tokens: 150_000, window: 200_000, windowSource: "provider" }, FABLE),
      savedChat({ tokens: 150_000, window: 200_000 }, SONNET),
    ]) {
      const model = task.modelSelection!.model;
      expect(toWireTask(task, model === FABLE.model ? FABLE : SONNET).usage?.context?.window).toBe(homeWindow(task, model));
    }
  });

  it("keeps a window that really is 200K at 200K", () => {
    const reported = savedChat({ tokens: 170_000, window: 200_000, windowSource: "provider" }, FABLE);
    expect(chatContext(reported, FABLE.model)).toEqual({ tokens: 170_000, window: 200_000, windowSource: "provider" });
    expect(homeCompacts(reported, FABLE.model)).toBe(true);
    const smaller = savedChat({ tokens: 170_000, window: 200_000 }, SONNET);
    expect(chatContext(smaller, SONNET.model)).toEqual({ tokens: 170_000, window: 200_000 });
    expect(homeCompacts(smaller, SONNET.model)).toBe(true);
  });
});
