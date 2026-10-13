import { describe, expect, it } from "vitest";
import type { EffortLevel, ModelCatalog } from "../contracts.ts";
import { claudeEffortArg, claudeEffortLevels, engineRefusesEffort, fittedEffort, offeredEffortLevels } from "./effort-levels.ts";

const CODEX: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const instance = (effortLevels: readonly EffortLevel[] | undefined, options: ModelCatalog["options"]) => ({
  models: { default: options[0]?.id ?? "", options },
  adapter: { capabilities: effortLevels ? { effortLevels } : {} },
});
const codex = instance(CODEX, [
  { id: "astra", label: "Astra", effortLevels: CODEX, defaultEffort: "medium" },
  { id: "luna", label: "Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "custom", label: "Custom" },
]);

describe("Claude effort levels", () => {
  it("adds Ultracode only from the CLI version that accepts it", () => {
    expect(claudeEffortLevels(null)).not.toContain("ultra");
    expect(claudeEffortLevels([2, 1, 292])).not.toContain("ultra");
    expect(claudeEffortLevels([2, 1, 293])).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(claudeEffortLevels([3, 0, 0])).toContain("ultra");
  });

  it("sends the top level by Claude Code's own flag name", () => {
    expect(claudeEffortArg("ultra")).toBe("ultracode");
    expect(claudeEffortArg("xhigh")).toBe("xhigh");
  });
});

describe("levels one model is offered", () => {
  it("narrows the engine's levels to the model's", () => {
    expect(offeredEffortLevels(codex, "astra")).toEqual(CODEX);
    expect(offeredEffortLevels(codex, "luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(offeredEffortLevels(codex, "custom")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(offeredEffortLevels(null, "astra")).toEqual([]);
    expect(offeredEffortLevels(instance(undefined, []), "astra")).toEqual([]);
  });

  it("steps a saved level down to what the model has", () => {
    expect(fittedEffort(codex, "luna", "ultra")).toBe("max");
    expect(fittedEffort(codex, "astra", "ultra")).toBe("ultra");
    expect(fittedEffort(codex, "luna", undefined)).toBeUndefined();
  });
});

describe("levels the engine refuses outright", () => {
  it("refuses a level the engine never accepts, but lets the top level step down instead", () => {
    const older = instance(["low", "medium", "high", "xhigh", "max"], []);
    expect(engineRefusesEffort(older, "none")).toBe(true);
    expect(engineRefusesEffort(older, "ultra")).toBe(false);
    expect(engineRefusesEffort(older, "max")).toBe(false);
    expect(engineRefusesEffort(older, undefined)).toBe(false);
  });
});
