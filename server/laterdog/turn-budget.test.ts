import { describe, expect, it } from "vitest";
import {
  HELPER_TURN_CONTEXT_TOKENS,
  HELPER_TURN_TOOL_CALLS,
  HelperTurnBudget,
} from "./turn-budget.ts";

const told = (budget: HelperTurnBudget, thread: string, calls: number, tokens?: number) =>
  Array.from({ length: calls }, (_, i) => (budget.toolUsed(thread, tokens) ? i + 1 : 0)).filter(
    Boolean,
  );

describe("a helper's bounded turn", () => {
  it("tells a helper to stop and report partly done at its 80th tool call, and again every 10 calls after", () => {
    const budget = new HelperTurnBudget();
    budget.begin("t");
    expect(told(budget, "t", 100)).toEqual([HELPER_TURN_TOOL_CALLS, 90, 100]);
    budget.begin("t");
    for (let i = 1; i < HELPER_TURN_TOOL_CALLS; i += 1) budget.toolUsed("t");
    const notice = budget.toolUsed("t", 120_000)!;
    expect(notice).toMatch(
      /^later\.dog: this helper turn has made 80 tool calls and carries about 120K tokens of context\./,
    );
    expect(notice).toMatch(
      /end your turn with a report that begins with partly done: what is finished, what is left and where things are/,
    );
  });

  it("tells it as soon as the context passes 160,000 tokens, however few calls it made", () => {
    const budget = new HelperTurnBudget();
    budget.begin("t");
    expect(budget.toolUsed("t", HELPER_TURN_CONTEXT_TOKENS - 1)).toBeNull();
    expect(budget.toolUsed("t", HELPER_TURN_CONTEXT_TOKENS)).toMatch(
      /made 2 tool calls and carries about 160K tokens/,
    );
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
    expect(budget.fromHook("t", { event: "PostToolUse", payload: { tool_use_id: "x" } })).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: expect.stringMatching(/partly done/),
    });
    expect(budget.fromHook("t", null)).toBeNull();
  });
});

describe("native helper checkpoints", () => {
  const event = (overrides: Partial<import("../contracts.ts").RuntimeEvent> = {}) =>
    ({
      eventId: "event",
      provider: "codex",
      providerInstanceId: "native",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-11-25T00:00:00.000Z",
      type: "item.completed",
      itemType: "tool",
      itemId: "tool",
      ok: true,
      ...overrides,
    }) as import("../contracts.ts").RuntimeEvent;
  const begin = (budget: HelperTurnBudget) => {
    budget.begin("t", "native");
    budget.bindNative("t", "native", "turn");
    expect(budget.fromNative(event({ type: "turn.started" }))).toBeNull();
  };

  it("counts each identified native completion once and leaves native hooks out of that count", () => {
    const budget = new HelperTurnBudget({ calls: 2 });
    begin(budget);
    expect(budget.fromNative(event())).toBeNull();
    expect(budget.fromNative(event({ eventId: "duplicate" }))).toBeNull();
    expect(budget.fromHook("t", { event: "PostToolUse" })).toBeNull();
    expect(budget.fromNative(event({ itemId: "second" }))).toMatch(/made 2 tool calls/);
  });

  it("ignores foreign providers, instances, threads and turns, unbound, synthetic and unidentified tools", () => {
    const budget = new HelperTurnBudget({ calls: 1 });
    budget.begin("t", "native");
    expect(budget.fromNative(event())).toBeNull();
    begin(budget);
    for (const overrides of [
      { provider: "claudeAgent" },
      { providerInstanceId: "other" },
      { threadId: "other" },
      { turnId: "old" },
      { turnId: undefined },
      { itemId: undefined },
      { synthetic: true },
      { type: "item.started" as const },
    ])
      expect(budget.fromNative(event(overrides))).toBeNull();
    expect(budget.fromNative(event())).toMatch(/made 1 tool calls/);
  });

  it("keeps the current binding across stale starts and ends, then resets for a new helper", () => {
    const budget = new HelperTurnBudget({ calls: 1 });
    begin(budget);
    budget.fromNative(event({ type: "turn.started", turnId: "old" }));
    budget.end("t", event({ type: "turn.completed", turnId: "old", ok: true }));
    budget.end("t", event({ type: "turn.completed", providerInstanceId: "other", ok: true }));
    expect(budget.fromNative(event())).toMatch(/made 1 tool calls/);
    budget.end("t", event({ type: "turn.completed", ok: true }));
    expect(budget.fromNative(event({ itemId: "after-end" }))).toBeNull();
    budget.begin("t", "native");
    budget.fromNative(event({ type: "turn.started", turnId: "next" }));
    expect(budget.fromNative(event({ itemId: "late" }))).toBeNull();
    budget.bindNative("t", "native", "next");
    budget.end("t", event({ type: "turn.completed", ok: true }));
    expect(budget.fromNative(event({ turnId: "next" }))).toMatch(/made 1 tool calls/);
    budget.end("t");
    expect(budget.fromNative(event({ itemId: "after-stop" }))).toBeNull();
  });

  it("leaves ordinary turns and the Claude hook counter independent of native events", () => {
    const budget = new HelperTurnBudget({ calls: 1 });
    expect(budget.fromNative(event())).toBeNull();
    budget.begin("t");
    expect(budget.fromNative(event({ type: "turn.started" }))).toBeNull();
    expect(budget.fromNative(event())).toBeNull();
    expect(budget.fromHook("t", { event: "PostToolUse" })?.additionalContext).toMatch(
      /made 1 tool calls/,
    );
  });
});

it("ignores a late stale start preceding the current dispatch binding", () => {
  const budget = new HelperTurnBudget({ calls: 1 });
  const event = (turnId: string, started = false) =>
    ({
      eventId: "late",
      provider: "codex",
      providerInstanceId: "native",
      threadId: "t",
      turnId,
      createdAt: "2026-11-25T00:00:00.000Z",
      ...(started
        ? { type: "turn.started" }
        : { type: "item.completed", itemType: "tool", itemId: "tool", ok: true }),
    }) as import("../contracts.ts").RuntimeEvent;
  budget.begin("t", "native");
  budget.fromNative(event("old", true));
  expect(budget.fromNative(event("old"))).toBeNull();
  budget.bindNative("t", "native", "current");
  budget.fromNative(event("old", true));
  budget.end("t", { ...event("old"), type: "turn.completed", ok: true });
  expect(budget.fromNative(event("old"))).toBeNull();
  expect(budget.fromNative(event("current"))).toMatch(/made 1 tool calls/);
});
