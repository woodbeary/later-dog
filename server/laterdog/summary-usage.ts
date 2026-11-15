import type { TextGenerationUsage } from "../contracts.ts";
import type { UsageRow } from "../usage-ledger.ts";
import type { DogWriter } from "./dog-writer.ts";

export const HISTORY_SUMMARY_PURPOSE = "history-summary";

export interface SummaryPayer {
  bot: { id: string; name: string };
  threadId: string;
  instance: { instanceId: string; driverKind: string };
}

export function summaryUsageRow({ bot, threadId, instance }: SummaryPayer, usage: TextGenerationUsage): Omit<UsageRow, "at" | "costSource"> {
  return {
    botId: bot.id,
    botName: bot.name,
    threadId,
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    model: usage.model,
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}),
    costUsd: usage.costUsd ?? null,
    trigger: { kind: "bot", botId: bot.id },
    purpose: HISTORY_SUMMARY_PURPOSE,
  };
}

export function reportingUsage(write: DogWriter | undefined, onUsage: (usage: TextGenerationUsage) => void): DogWriter | undefined {
  if (!write) return undefined;
  return Object.assign((prompt: string, options?: Parameters<DogWriter>[1]) => write(prompt, { ...options, onUsage }), { model: write.model });
}
