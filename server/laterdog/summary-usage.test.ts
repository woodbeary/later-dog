import { expect, it, vi } from "vitest";

import type { TextGenerationOptions } from "../contracts.ts";
import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { dogWriter } from "./dog-writer.ts";
import { HISTORY_SUMMARY_PURPOSE, reportingUsage, summaryUsageRow } from "./summary-usage.ts";

const payer = { bot: { id: "b1", name: "Coordinator" }, threadId: "t1", instance: { instanceId: "claudeWork", driverKind: "claudeAgent" } };

it("books a summary's usage to the chat and the account that paid, marked as a summary", () => {
  expect(summaryUsageRow(payer, { model: "claude-sonnet-4-6", input: 15, output: 5, cachedInput: 2, costUsd: 0.01 })).toEqual({
    botId: "b1", botName: "Coordinator", threadId: "t1", instanceId: "claudeWork", driverKind: "claudeAgent",
    model: "claude-sonnet-4-6", input: 15, output: 5, cachedInput: 2, costUsd: 0.01,
    trigger: { kind: "bot", botId: "b1" }, purpose: HISTORY_SUMMARY_PURPOSE,
  });
  expect(summaryUsageRow(payer, { model: "m" })).toMatchObject({ input: 0, output: 0, costUsd: null });
});

it("keeps the summary on the paying dog's model and books the usage reported by its engine", async () => {
  const usage = { model: "claude-sonnet-5-5", input: 20, output: 6 };
  const generateText = vi.fn(async (_prompt: string, options?: TextGenerationOptions) => {
    options?.onUsage?.(usage);
    return "text";
  });
  const book = vi.fn();
  const write = reportingUsage(dogWriter({ models: STATIC_CLAUDE_MODELS, generateText }, usage.model, payer.bot.id),
    (reported) => book(summaryUsageRow(payer, reported)))!;
  const signal = new AbortController().signal;
  expect(write.model).toBe(usage.model);
  await expect(write("prompt", { signal, botId: "another-dog" })).resolves.toBe("text");
  expect(generateText).toHaveBeenCalledWith("prompt", { signal, model: usage.model, botId: payer.bot.id, onUsage: expect.any(Function) });
  expect(book).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    botId: payer.bot.id, instanceId: payer.instance.instanceId, threadId: payer.threadId, ...usage, purpose: HISTORY_SUMMARY_PURPOSE,
  }));
  expect(reportingUsage(undefined, () => {})).toBeUndefined();
});
