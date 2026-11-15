import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { memoryWriterModel, upkeepModelFor } from "./upkeep-model.ts";

it("runs memory upkeep one tier below the dog's model, never below the middle tier", () => {
  expect(upkeepModelFor("claude", "claude-fable-5-2")).toBe("opus");
  expect(upkeepModelFor("claude", "claude-opus-5-5")).toBe("sonnet");
  expect(upkeepModelFor("claude", "claude-opus-5-5[1m]")).toBe("sonnet");
  expect(upkeepModelFor("claude", "opus")).toBe("sonnet");
  expect(upkeepModelFor("claude", "claude-sonnet-5-5")).toBeNull();
  expect(upkeepModelFor("claude", "claude-haiku-5-5")).toBeNull();
});

it("leaves the dog's own model for an unknown model, a custom endpoint and another engine", () => {
  for (const model of [undefined, null, "", "local-model", "orcarouter/Qwen3.8-27B", "kimi-k2.6"]) {
    expect(upkeepModelFor("claude", model)).toBeNull();
  }
  expect(upkeepModelFor("codex", "gpt-5.6-sol")).toBeNull();
  expect(memoryWriterModel("claudeAgent", "claude-opus-5-5")).toBe("sonnet");
  expect(memoryWriterModel("claudeAgent", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  expect(memoryWriterModel("claudeAgent", "kimi-k2.6")).toBe("kimi-k2.6");
  expect(memoryWriterModel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(memoryWriterModel("claudeAgent", undefined)).toBeUndefined();
});

it("is the model memory upkeep writes with, and the summary on a move keeps the chat's own", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toMatch(/memoryUpkeep = createMemoryUpkeep\([\s\S]{0,600}dogWriter\(instance, memoryWriterModel\(instance\.driverKind, bot\.modelSelection\.model\)\)/);
  expect(source).toMatch(/write: reportingUsage\(dogWriter\(instance, model\)/);
});
