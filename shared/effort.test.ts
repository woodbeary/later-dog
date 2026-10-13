import { describe, expect, it } from "vitest";
import { fitEffort, modelEffort, modelEffortLevels, STANDARD_EFFORT_LEVELS } from "./effort.ts";
import type { EffortLevel } from "./wire.ts";

const CODEX: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

describe("effort levels for one model", () => {
  it("keeps the engine's order and only what the model lists", () => {
    expect(modelEffortLevels(CODEX, { effortLevels: ["max", "low", "medium"] })).toEqual(["low", "medium", "max"]);
    expect(modelEffortLevels(CODEX, { effortLevels: [] })).toEqual([]);
  });

  it("never assumes the top level for a model that does not list it", () => {
    expect(modelEffortLevels(CODEX)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelEffortLevels(CODEX, {})).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(STANDARD_EFFORT_LEVELS).not.toContain("ultra");
  });
});

describe("fitting a saved level to a model", () => {
  it("keeps a level the model has", () => {
    expect(fitEffort(CODEX, "ultra")).toBe("ultra");
    expect(fitEffort(CODEX, undefined)).toBeUndefined();
  });

  it("steps down to the nearest lower level the model has", () => {
    expect(fitEffort(["low", "medium", "high", "xhigh", "max"], "ultra")).toBe("max");
    expect(fitEffort(["low", "medium", "high", "xhigh"], "max")).toBe("xhigh");
    expect(fitEffort(["low", "high"], "medium")).toBe("low");
  });

  it("lets the provider decide when nothing lower fits", () => {
    expect(fitEffort(["medium", "high"], "low")).toBeUndefined();
    expect(fitEffort(["low", "medium"], "none")).toBeUndefined();
    expect(fitEffort([], "max")).toBeUndefined();
  });
});

describe("reading a provider's reasoning list", () => {
  it("takes known levels in order with the provider's default", () => {
    const rows = [{ reasoningEffort: "ultra" }, { reasoningEffort: "low" }, { reasoningEffort: "minimal" }, { reasoningEffort: "medium" }, null, "high"];
    expect(modelEffort(rows, "reasoningEffort", "medium")).toEqual({ effortLevels: ["low", "medium", "ultra"], defaultEffort: "medium" });
  });

  it("drops a default the list does not have, and says nothing without a list", () => {
    expect(modelEffort([{ effort: "low" }], "effort", "high")).toEqual({ effortLevels: ["low"] });
    expect(modelEffort(undefined, "effort", "high")).toEqual({});
    expect(modelEffort([], "effort", undefined)).toEqual({ effortLevels: [] });
  });
});
