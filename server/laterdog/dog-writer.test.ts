import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { APPROVAL_REVIEW_MODEL, dogWriter, writingModel } from "./dog-writer.ts";

const SMALLEST = APPROVAL_REVIEW_MODEL;

it("writes with the chat's own model, which the turn is about to run on that account", () => {
  expect(writingModel("claude-fable-5-2", STATIC_CLAUDE_MODELS)).toBe("claude-fable-5-2");
  expect(writingModel("claude-sonnet-4-6", STATIC_CLAUDE_MODELS)).toBe("claude-sonnet-4-6");
});

it("writes with the account's own default, never the smallest, when no chat model is known", () => {
  expect(writingModel(undefined, STATIC_CLAUDE_MODELS)).toBe(STATIC_CLAUDE_MODELS.default);
  expect(writingModel(" ", STATIC_CLAUDE_MODELS)).not.toBe(SMALLEST);
  expect(writingModel(undefined, { default: "", options: [] })).toBeUndefined();
});

it("passes the chosen model on every call", async () => {
  const generateText = vi.fn(async () => "text");
  const write = dogWriter({ models: STATIC_CLAUDE_MODELS, generateText }, "claude-sonnet-5-5")!;
  expect(write.model).toBe("claude-sonnet-5-5");
  await write("prompt", { signal: new AbortController().signal });
  expect(generateText).toHaveBeenCalledWith("prompt", expect.objectContaining({ model: "claude-sonnet-5-5" }));
  expect(dogWriter({ models: STATIC_CLAUDE_MODELS }, "claude-sonnet-5-5")).toBeUndefined();
});

it("leaves no caller that writes a dog's memory or history to the driver's smallest default", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const reads = source.split("\n").map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => /\bgenerateText\b/.test(line));
  const unnamed = reads.filter(({ line }) => !/dogWriter\(|[Tt]itle|provider\.generateText|provider: \{ generateText|generateText: async \(prompt, options\)/.test(line));
  expect(unnamed, "every one-shot model call in server/index.ts that is not a chat title must go through dogWriter").toEqual([]);
  expect(source).toMatch(/memoryUpkeep = createMemoryUpkeep\([\s\S]{0,600}dogWriter\(instance, memoryWriterModel\(instance\.driverKind, bot\.modelSelection\.model,/);
  expect(source).toMatch(/writeHistorySummary\([^)]*write: reportingUsage\(dogWriter\(instance, model\)/);
});
