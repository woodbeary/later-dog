import { describe, expect, it } from "vitest";

import { DECIDE_YOURSELF, HAND_OFF_NOW, HELPER_IN_BACKGROUND, REPLY_FIRST_HELD, TurnShape } from "./turn-shape.ts";

const pre = (tool_name: string, tool_input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ event: "PreToolUse", payload: { tool_name, tool_input, ...extra } });
const post = (extra: Record<string, unknown> = {}) => ({ event: "PostToolUse", payload: { tool_name: "Read", tool_response: "ok", ...extra } });
const reason = (decision: ReturnType<TurnShape["beforeTool"]>) => decision?.permissionDecisionReason ?? null;

describe("the shape of a turn the person started", () => {
  it("holds every tool, a plan included, until the person has had a reply, and lets a tapback through", () => {
    const shape = new TurnShape();
    shape.begin("t", { replyFirst: true, handOff: false });
    expect(shape.awaitsReply("t", pre("mcp__agents__set_plan"))).toBe(true);
    expect(reason(shape.beforeTool("t", pre("mcp__agents__set_plan")))).toBe(REPLY_FIRST_HELD);
    expect(reason(shape.beforeTool("t", pre("Bash", { command: "ls" })))).toBe(REPLY_FIRST_HELD);
    expect(shape.beforeTool("t", pre("mcp__agents__react"))).toBeNull();
    shape.replied("t");
    expect(shape.awaitsReply("t", pre("Bash"))).toBe(false);
    expect(shape.beforeTool("t", pre("Bash", { command: "ls" }))).toBeNull();
    expect(shape.facts("t")).toMatchObject({ replied: true, held: 2 });
  });

  it("never holds a helper's own tools, a routine's turn or a turn that has ended", () => {
    const shape = new TurnShape();
    shape.begin("t", { replyFirst: true, handOff: true });
    expect(shape.beforeTool("t", pre("Bash", {}, { agent_id: "helper-1" }))).toBeNull();
    shape.begin("r", { replyFirst: false, handOff: false });
    expect(shape.beforeTool("r", pre("Bash"))).toBeNull();
    shape.end("t");
    expect(shape.beforeTool("t", pre("Bash"))).toBeNull();
  });

  it("lets two rounds of the dog's own tool calls run, holds the third, and frees the turn once a background helper has the work", () => {
    const shape = new TurnShape();
    shape.begin("t", { replyFirst: true, handOff: true });
    shape.replied("t");
    expect(shape.beforeTool("t", pre("Read"))).toBeNull();
    expect(shape.beforeTool("t", pre("Grep"))).toBeNull();
    shape.afterTool("t", post());
    shape.afterTool("t", post());
    expect(shape.beforeTool("t", pre("Read"))).toBeNull();
    shape.afterTool("t", post());
    expect(shape.beforeTool("t", pre("mcp__agents__set_plan"))).toBeNull();
    expect(shape.beforeTool("t", pre("Bash", { command: "pnpm test", run_in_background: true }))).toBeNull();
    expect(reason(shape.beforeTool("t", pre("Edit")))).toBe(HAND_OFF_NOW);
    expect(reason(shape.beforeTool("t", pre("Edit")))).toBe(HAND_OFF_NOW);
    expect(reason(shape.beforeTool("t", pre("Agent", { prompt: "fix it" })))).toBe(HELPER_IN_BACKGROUND);
    expect(shape.beforeTool("t", pre("Agent", { prompt: "fix it", run_in_background: true }))).toBeNull();
    expect(shape.beforeTool("t", pre("Edit"))).toBeNull();
    expect(shape.facts("t")).toMatchObject({ handedOff: true, rounds: 3 });
  });

  it("does not count a helper's results as the dog's rounds", () => {
    const shape = new TurnShape();
    shape.begin("t", { replyFirst: false, handOff: true });
    expect(shape.beforeTool("t", pre("Read"))).toBeNull();
    shape.afterTool("t", post({ agent_id: "helper-1" }));
    expect(shape.beforeTool("t", pre("Read"))).toBeNull();
    expect(shape.facts("t")?.rounds).toBe(1);
  });
});

describe("questions the dog asks the person", () => {
  it("holds a question card outside dog setup and lets it through while a new dog is being set up", () => {
    const shape = new TurnShape();
    shape.begin("t", { replyFirst: false, handOff: false, questions: false });
    expect(shape.beforeTool("t", pre("AskUserQuestion"))?.permissionDecisionReason).toBe(DECIDE_YOURSELF);
    expect(shape.beforeTool("t", pre("mcp__codex__request_user_input"))?.permissionDecisionReason).toBe(DECIDE_YOURSELF);
    expect(shape.beforeTool("t", pre("Bash"))).toBeNull();
    shape.begin("new", { replyFirst: false, handOff: false, questions: true });
    expect(shape.beforeTool("new", pre("AskUserQuestion"))).toBeNull();
  });
});
