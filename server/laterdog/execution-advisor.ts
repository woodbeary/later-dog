import type { ModelSelection } from "../../shared/wire.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { LIST_PRICES } from "../model-prices.ts";

export interface AdviceCandidate {
  instanceId: string;
  model: string;
  enabled: boolean;
  authenticated: boolean;
  available: boolean;
  effortLevels?: readonly string[];
  restingUntil?: string;
}

export function executionAdvice(input: {
  task: string;
  current: ModelSelection;
  candidates: readonly AdviceCandidate[];
  rows: readonly UsageRow[];
  now: number;
}) {
  const words = input.task.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const recent = input.rows.filter((row) => {
    const at = Date.parse(row.at);
    return Number.isFinite(at) && at <= input.now && at >= input.now - 30 * 86_400_000;
  });
  const seen = new Set<string>();
  const unique = recent.filter((row) => {
    const key = row.execution?.turnId ? `${row.threadId}:${row.execution.turnId}:${row.instanceId}` : `${row.at}:${row.threadId}:${row.instanceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const matching = unique.filter((row) => row.execution && words.some((word) => row.execution!.task.toLowerCase().includes(word)));
  const evidence = matching.length ? matching : unique;
  const ordered = [...input.candidates].sort((a, b) => Number(b.instanceId === input.current.instanceId && b.model === input.current.model) - Number(a.instanceId === input.current.instanceId && a.model === input.current.model));
  const candidates = ordered.slice(0, 100).map((candidate) => {
    const rows = evidence.filter((row) => row.instanceId === candidate.instanceId && row.model === candidate.model);
    const attributed = rows.filter((row) => row.execution && row.execution.attribution !== "conflict");
    const priced = rows.filter((row) => typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0);
    const price = LIST_PRICES[candidate.model];
    const samples = attributed.filter((row) => row.input > 0 || row.output > 0);
    const durations = attributed.map((row) => row.execution!.durationMs).sort((a, b) => a - b);
    return {
      instanceId: candidate.instanceId, model: candidate.model, effortLevels: candidate.effortLevels ?? [],
      eligible: candidate.enabled && candidate.authenticated && candidate.available && !(candidate.restingUntil && Date.parse(candidate.restingUntil) > input.now),
      restingUntil: candidate.restingUntil ?? null,
      unavailableReason: !candidate.enabled ? "disabled" : !candidate.authenticated ? "signed_out" : !candidate.available ? "unavailable" : candidate.restingUntil && Date.parse(candidate.restingUntil) > input.now ? "usage_limit" : null,
      standardApiListPrice: price ? { inputPerMillion: price.inputPerMillion, cachedInputPerMillion: price.cachedInputPerMillion ?? null, outputPerMillion: price.outputPerMillion, asOf: price.asOf, source: price.source } : null,
      observations: {
        recordedTurns: rows.length, attributedTurns: attributed.length, nonzeroUsageTurns: samples.length,
        providerSucceeded: attributed.filter((row) => row.execution!.providerSucceeded).length,
        verifiedTasks: 0,
        medianObservedExecutionMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
        recordedCostUsd: priced.length ? priced.reduce((sum, row) => sum + row.costUsd!, 0) : null,
        unpricedTurns: rows.length - priced.length,
        estimatedCostTurns: rows.filter((row) => row.costSource === "estimated").length,
      },
      evidence: attributed.slice(-5).map((row) => ({ threadId: row.threadId, turnId: row.execution!.turnId ?? null, at: row.at, verification: row.execution!.verification })),
    };
  });
  return {
    version: 1, task: input.task, current: input.current,
    recommendation: { action: "keep_current", selection: input.current, confidence: null, reason: "No controlled, task-verified comparison is available. Preserve the selected model and effort; use the observations to plan a bounded comparison." },
    scope: matching.length ? "matching_task_words" : "own_dog_history",
    coverage: { recordedTurns: unique.length, legacyTurns: unique.filter((row) => !row.execution).length, conflictingTurns: unique.filter((row) => row.execution?.attribution === "conflict").length, duplicateRowsExcluded: recent.length - unique.length, candidatesOmitted: Math.max(0, ordered.length - candidates.length) },
    candidates,
    limitations: ["Provider success is not task verification.", "Historical observations are not controlled model comparisons.", "API list prices are standard base rates, not subscription charges or an invoice; cache writes, long context, processing tiers and regional premiums may differ.", "Execution duration excludes queue time, earlier attempts and later rescue.", "No model, effort, account or dispatch setting was changed."],
  };
}
