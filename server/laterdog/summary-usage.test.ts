import { expect, it, vi } from "vitest";

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

it("asks the engine to report usage on every call and keeps the writer's model", async () => {
  const generateText = vi.fn(async () => "text");
  const seen: unknown[] = [];
  const write = reportingUsage(dogWriter({ models: STATIC_CLAUDE_MODELS, generateText }, "claude-sonnet-5-5"), (usage) => seen.push(usage))!;
  expect(write.model).toBe("claude-sonnet-5-5");
  await write("prompt", { signal: new AbortController().signal });
  const options = (generateText.mock.calls[0] as unknown as [string, { onUsage: (usage: unknown) => void; model: string }])[1];
  options.onUsage({ model: "x" });
  expect(options.model).toBe("claude-sonnet-5-5");
  expect(seen).toEqual([{ model: "x" }]);
  expect(reportingUsage(undefined, () => {})).toBeUndefined();
});
