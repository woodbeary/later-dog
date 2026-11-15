import { describe, expect, it } from "vitest";

import { disallowedWithOnePlan, ENGINE_PLAN_TOOLS, hasSetPlan } from "./one-plan.ts";

describe("one plan per dog", () => {
  it("turns off the engine's task-list tools only when the dog has set_plan, keeping what was already denied", () => {
    expect(disallowedWithOnePlan(["Edit"], true)).toEqual(["Edit", ...ENGINE_PLAN_TOOLS]);
    expect(disallowedWithOnePlan(["TodoWrite"], true)).toEqual(["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
    expect(disallowedWithOnePlan(undefined, true)).toEqual([...ENGINE_PLAN_TOOLS]);
    expect(disallowedWithOnePlan(["Edit"], false)).toEqual(["Edit"]);
    expect(disallowedWithOnePlan(undefined, false)).toEqual([]);
  });

  it("counts set_plan only where later.dog's agents tools are mounted and the dog's tool scope lets it use set_plan", () => {
    const agents = { agents: {} };
    expect(hasSetPlan(agents, undefined)).toBe(true);
    expect(hasSetPlan(agents, { allow: ["native:*", "mcp:agents:*"] })).toBe(true);
    expect(hasSetPlan(agents, { allow: ["mcp:agents:set_plan"] })).toBe(true);
    expect(hasSetPlan(agents, { deny: ["mcp:agents:set_plan"] })).toBe(false);
    expect(hasSetPlan(agents, { allow: ["native:*", "mcp:agents:list_bots"] })).toBe(false);
    expect(hasSetPlan(agents, { allow: ["native:*"] })).toBe(false);
    expect(hasSetPlan({}, undefined)).toBe(false);
  });
});
