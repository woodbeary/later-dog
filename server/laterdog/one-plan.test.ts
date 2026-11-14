import { describe, expect, it } from "vitest";

import { disallowedWithOnePlan, ENGINE_PLAN_TOOLS } from "./one-plan.ts";

describe("one plan per dog", () => {
  it("turns off the engine's task-list tools only when the dog has set_plan, keeping what was already denied", () => {
    expect(disallowedWithOnePlan(["Edit"], true)).toEqual(["Edit", ...ENGINE_PLAN_TOOLS]);
    expect(disallowedWithOnePlan(["TodoWrite"], true)).toEqual(["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
    expect(disallowedWithOnePlan(undefined, true)).toEqual([...ENGINE_PLAN_TOOLS]);
    expect(disallowedWithOnePlan(["Edit"], false)).toEqual(["Edit"]);
    expect(disallowedWithOnePlan(undefined, false)).toEqual([]);
  });
});
