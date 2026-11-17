import { describe, expect, it } from "vitest";

import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { modelFamily } from "./dog-guidance.ts";
import { DEFER_PROVEN_FAMILIES, claudeCustomEndpoint, deferRareToolsFor, deferSetting } from "./defer-by-model.ts";

const byModel = (model: string | null | undefined, customEndpoint = false) => deferRareToolsFor({ model, customEndpoint }, {});

describe("rare tools on demand, by model", () => {
  it("is on for every model in the proven table and off for every other model later.dog offers", () => {
    const offered = STATIC_CLAUDE_MODELS.options.map((option) => option.id);
    const on = offered.filter((model) => byModel(model));
    expect(on.sort()).toEqual(["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-opus-5", "claude-opus-5-5"]);
    for (const model of offered) expect([model, byModel(model)]).toEqual([model, DEFER_PROVEN_FAMILIES.has(modelFamily(model))]);
  });

  it("is off for the smallest model, a model outside the table, an unknown model and no model", () => {
    for (const model of ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-4-1", "gpt-5.5", "glm-4.6", "some-new-model", "", null, undefined]) {
      expect([model, byModel(model)]).toEqual([model, false]);
    }
  });

  it("reads the model the way the standing instructions do, suffixes and prefixes included", () => {
    expect(byModel("claude-opus-5-5[1m]")).toBe(true);
    expect(byModel("CLAUDE-FABLE-5-2")).toBe(true);
    expect(byModel("us.anthropic.claude-opus-5-5-v1:0")).toBe(true);
  });

  it("matches whole version parts, so a dated or prefixed proven id is on and a longer number is unknown", () => {
    const on = [
      "claude-opus-5-20261101", "claude-opus-5-5-20261101", "claude-fable-5-20260601", "claude-fable-5-2-20261020",
      "claude-opus-5[1m]", "claude-opus-5-5[1M]", "anthropic/claude-opus-5-5", "us.anthropic.claude-fable-5-1-v1:0", "claude-opus-5.5",
    ];
    const off = [
      "claude-opus-50", "claude-opus-55", "claude-opus-5-50", "claude-fable-52", "claude-fable-5-3", "claude-opus-5-1",
      "opus", "fable", "opus[1m]", "claude-opus", "", "   ",
    ];
    for (const model of on) expect([model, byModel(model)]).toEqual([model, true]);
    for (const model of off) expect([model, byModel(model)]).toEqual([model, false]);
    expect(modelFamily("claude-fable-5-20260601")).toBe("fable-5");
    expect(modelFamily("claude-opus-5-20261101")).toBe("opus-5");
    expect(modelFamily("claude-opus-50")).toBe("other");
  });

  it("is off on a custom endpoint, even for a proven model", () => {
    expect(byModel("claude-opus-5-5", true)).toBe(false);
  });

  it("lets the setting force it on or off for any model and endpoint", () => {
    for (const value of ["1", "on", "true", " ON "]) {
      expect(deferSetting({ LATERDOG_DEFER_RARE_TOOLS: value })).toBe("on");
      expect(deferRareToolsFor({ model: "claude-haiku-5-5", customEndpoint: true }, { LATERDOG_DEFER_RARE_TOOLS: value })).toBe(true);
      expect(deferRareToolsFor({ model: undefined, customEndpoint: false }, { LATERDOG_DEFER_RARE_TOOLS: value })).toBe(true);
    }
    for (const value of ["0", "off", "false"]) {
      expect(deferSetting({ LATERDOG_DEFER_RARE_TOOLS: value })).toBe("off");
      expect(deferRareToolsFor({ model: "claude-opus-5-5", customEndpoint: false }, { LATERDOG_DEFER_RARE_TOOLS: value })).toBe(false);
    }
    for (const value of [undefined, "", "auto", "yes please"]) {
      expect(deferSetting({ LATERDOG_DEFER_RARE_TOOLS: value })).toBe("by-model");
    }
  });

  it("counts another host, a cloud provider or an unreadable address as a custom endpoint", () => {
    expect(claudeCustomEndpoint({})).toBe(false);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "" })).toBe(false);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(false);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" })).toBe(false);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "https://models.example.test/anthropic" })).toBe(true);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" })).toBe(true);
    expect(claudeCustomEndpoint({ ANTHROPIC_BASE_URL: "not a url" })).toBe(true);
    expect(claudeCustomEndpoint({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(claudeCustomEndpoint({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe(true);
    expect(claudeCustomEndpoint({ CLAUDE_CODE_USE_FOUNDRY: "1" })).toBe(true);
    expect(claudeCustomEndpoint({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
    expect(claudeCustomEndpoint({ CLAUDE_CODE_USE_VERTEX: "false" })).toBe(false);
  });
});
