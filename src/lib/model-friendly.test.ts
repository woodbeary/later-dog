import { describe, expect, it } from "vitest";
import type { EffortLevel } from "../../shared/wire";
import type { InstanceInfo } from "@/state/store";
import { effortLevelsFor, effortName, effortNote, modelBlurb, recommendedEffort, simpleEffortLevels } from "./model-friendly";

const ALL: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

describe("simple effort levels", () => {
  it("offers low, medium, high and max when the engine has them", () => {
    expect(simpleEffortLevels(["none", "low", "medium", "high", "xhigh", "max"], undefined)).toEqual(["low", "medium", "high", "max"]);
  });

  it("uses the extra-high step as the top when there is no max", () => {
    expect(simpleEffortLevels(["low", "medium", "high", "xhigh"], undefined)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("adds the top level that can split work when the model has it", () => {
    expect(simpleEffortLevels(ALL, undefined)).toEqual(["low", "medium", "high", "max", "ultra"]);
  });

  it("never hides the level a bot is already using", () => {
    expect(simpleEffortLevels(["none", "low", "medium", "high", "xhigh", "max"], "xhigh")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(simpleEffortLevels(["none", "low", "medium", "high"], "none")).toEqual(["none", "low", "medium", "high"]);
  });

  it("ignores a stale current level the engine no longer offers", () => {
    expect(simpleEffortLevels(["low", "high"], "max")).toEqual(["low", "high"]);
  });

  it("returns nothing for an engine without effort levels", () => {
    expect(simpleEffortLevels([], undefined)).toEqual([]);
  });
});

describe("effort names", () => {
  it("uses each provider's own words", () => {
    expect(ALL.map((level) => effortName(level, "codex"))).toEqual(["Low", "Medium", "High", "Extra high", "Max", "Ultra"]);
    expect(ALL.map((level) => effortName(level, "claudeAgent"))).toEqual(["Low", "Medium", "High", "xHigh", "Max", "Ultracode"]);
    expect(effortName("none", "piAgent")).toBe("Off");
    expect(effortName("xhigh")).toBe("Extra high");
  });

  it("explains only the level that can split work across helpers", () => {
    expect(effortNote("ultra")).toMatch(/several helpers/);
    expect(effortNote("max")).toBeUndefined();
  });
});

describe("effort levels for one model", () => {
  const engine = (options: InstanceInfo["models"]["options"], effortLevels: EffortLevel[] = ALL): InstanceInfo => ({
    instanceId: "codex", driverKind: "codex", displayName: "Codex",
    snapshot: { state: "available", authenticated: true },
    models: { default: options[0]?.id ?? "", options },
    capabilities: { effortLevels },
  }) as InstanceInfo;

  it("keeps only what both the engine and the model offer", () => {
    const codex = engine([{ id: "luna", label: "Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"] }]);
    expect(effortLevelsFor(codex, "luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsFor(engine([{ id: "sol", label: "Sol", effortLevels: ALL }], ["low", "medium", "high"]), "sol")).toEqual(["low", "medium", "high"]);
  });

  it("holds back the top level for a model that never said it has it", () => {
    expect(effortLevelsFor(engine([{ id: "custom", label: "Custom" }]), "custom")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsFor(engine([]), "unknown")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("offers nothing for a model without an effort control", () => {
    expect(effortLevelsFor(engine([{ id: "haiku", label: "Haiku", effortLevels: [] }]), "haiku")).toEqual([]);
    expect(effortLevelsFor(undefined, "anything")).toEqual([]);
  });

  it("recommends the model's own default, then medium", () => {
    expect(recommendedEffort(ALL, "low")).toBe("low");
    expect(recommendedEffort(ALL)).toBe("medium");
    expect(recommendedEffort(["low", "high"], "medium")).toBeUndefined();
  });
});

describe("model blurbs", () => {
  it("describes the well-known Claude families", () => {
    expect(modelBlurb({ id: "claude-opus-5-5", label: "Opus 5.5" })).toMatch(/Smartest/);
    expect(modelBlurb({ id: "claude-sonnet-5-5", label: "Sonnet 5.5" })).toMatch(/most work/);
    expect(modelBlurb({ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" })).toMatch(/Quickest/);
  });

  it("calls small variants light without guessing at unknown models", () => {
    expect(modelBlurb({ id: "gpt-5-mini", label: "GPT-5 mini" })).toMatch(/light/);
    expect(modelBlurb({ id: "minimax-m2", label: "MiniMax M2" })).toBeUndefined();
    expect(modelBlurb({ id: "grok-4", label: "Grok 4" })).toBeUndefined();
  });
});
