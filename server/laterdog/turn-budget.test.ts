import { describe, expect, it } from "vitest";
import { HELPER_TURN_CONTEXT_TOKENS, HELPER_TURN_TOOL_CALLS, HelperTurnBudget } from "./turn-budget.ts";

const told = (budget: HelperTurnBudget, thread: string, calls: number, tokens?: number) =>
  Array.from({ length: calls }, (_, i) => (budget.toolUsed(thread, tokens) ? i + 1 : 0)).filter(Boolean);

describe("a helper's bounded turn", () => {
  it("tells a helper to stop and report partly done at its 80th tool call, and again every 10 calls after", () => {
    const budget = new HelperTurnBudget();
    budget.begin("t");
    expect(told(budget, "t", 100)).toEqual([HELPER_TURN_TOOL_CALLS, 90, 100]);
    budget.begin("t");
    for (let i = 1; i < HELPER_TURN_TOOL_CALLS; i += 1) budget.toolUsed("t");
    const notice = budget.toolUsed("t", 120_000)!;
    expect(notice).toMatch(/^later\.dog: this helper turn has made 80 tool calls and carries about 120K tokens of context\./);
    expect(notice).toMatch(/end your turn with a report that begins with partly done: what is finished, what is left and where things are/);
  });

  it("tells it as soon as the context passes 160,000 tokens, however few calls it made", () => {
    const budget = new HelperTurnBudget();
    budget.begin("t");
    expect(budget.toolUsed("t", HELPER_TURN_CONTEXT_TOKENS - 1)).toBeNull();
    expect(budget.toolUsed("t", HELPER_TURN_CONTEXT_TOKENS)).toMatch(/made 2 tool calls and carries about 160K tokens/);
  });

  it("leaves a dog's own turns alone, and forgets a helper turn once it ends", () => {
    const budget = new HelperTurnBudget({ calls: 2 });
    expect(told(budget, "own", 200, 500_000)).toEqual([]);
    budget.begin("t");
    budget.end("t");
    expect(told(budget, "t", 5)).toEqual([]);
  });

  it("answers only a PostToolUse hook, in the shape the engine reads as added context", () => {
    const budget = new HelperTurnBudget({ calls: 1 });
    budget.begin("t");
    expect(budget.fromHook("t", { event: "Stop", payload: {} })).toBeNull();
    expect(budget.fromHook("t", { event: "PostToolUse", payload: { tool_use_id: "x" } })).toEqual({ hookEventName: "PostToolUse", additionalContext: expect.stringMatching(/partly done/) });
    expect(budget.fromHook("t", null)).toBeNull();
  });
});
