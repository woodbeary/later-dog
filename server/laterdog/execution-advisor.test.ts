import { describe, expect, it } from "vitest";
import { executionAdvice, type AdviceCandidate } from "./execution-advisor.ts";
import type { UsageRow } from "../usage-ledger.ts";

const now = Date.parse("2026-11-08T12:00:00Z");
const current = { instanceId: "codex", model: "gpt-6.1-sol", effort: "medium" as const };
const candidate: AdviceCandidate = { ...current, enabled: true, authenticated: true, available: true };
const row = (patch: Partial<UsageRow> = {}): UsageRow => ({ at: "2026-11-08T10:00:00Z", botId: "dog", botName: "Dog", threadId: "thread", instanceId: current.instanceId, driverKind: "codex", model: current.model, input: 100, output: 10, costUsd: null, trigger: { kind: "owner" }, ...patch });
const execution: NonNullable<UsageRow["execution"]> = { selected: current, dispatched: current, providerInstanceId: "codex", attribution: "dispatch", turnId: "turn", startedAt: "2026-11-08T09:59:59Z", completedAt: "2026-11-08T10:00:00Z", durationMs: 1000, providerSucceeded: true, verification: "unverified" };
const titles = new Map<string, string>();
const advise = (rows: UsageRow[], candidates = [candidate]) => executionAdvice({ task: "repair accounts", current, candidates, rows, titles, now });

describe("optional execution advice", () => {
  it("preserves the exact selected model and effort with no observations", () => {
    const result = advise([]);
    expect(result.recommendation).toMatchObject({ action: "keep_current", selection: current, confidence: null });
    expect(result.candidates[0]?.observations.medianObservedExecutionMs).toBeNull();
    expect(result.candidates[0]?.observations.recordedCostUsd).toBeNull();
  });

  it("keeps legacy successes and conflicts out of attributed results", () => {
    const result = advise([row(), row({ at: "2026-11-08T10:01:00Z", execution: { ...execution, attribution: "conflict" } })]);
    expect(result.coverage).toMatchObject({ legacyTurns: 1, conflictingTurns: 1 });
    expect(result.candidates[0]?.observations).toMatchObject({ attributedTurns: 0, verifiedTasks: 0 });
  });

  it("deduplicates turns, separates estimates, and never promotes provider success to verification", () => {
    const record = row({ execution, costUsd: 0.02, costSource: "estimated" });
    const result = advise([record, record, row({ at: "2020-01-01", execution }), row({ at: "2030-01-01", execution })]);
    expect(result.coverage.duplicateRowsExcluded).toBe(1);
    expect(result.candidates[0]?.observations).toMatchObject({ providerSucceeded: 1, verifiedTasks: 0, medianObservedExecutionMs: 1000, recordedCostUsd: 0.02, estimatedCostTurns: 1 });
    expect(result.candidates[0]?.evidence).toHaveLength(1);
    expect(result.recommendation.action).toBe("keep_current");
  });

  it("reports the median across both middle observations for even samples", () => {
    const result = advise([row({ execution: { ...execution, turnId: "first", durationMs: 100 } }), row({ execution: { ...execution, turnId: "second", durationMs: 10_000 } })]);
    expect(result.candidates[0]?.observations.medianObservedExecutionMs).toBe(5050);
  });

  it("marks a resting account unavailable until its reset", () => {
    const result = advise([], [{ ...candidate, restingUntil: "2026-11-09T00:00:00Z" }]);
    expect(result.candidates[0]).toMatchObject({ eligible: false, unavailableReason: "usage_limit" });
  });

  it("shows unavailable candidates and missing prices honestly", () => {
    const result = advise([], [{ ...candidate, enabled: false }, { ...candidate, model: "unknown-model", authenticated: false }]);
    expect(result.candidates.map((c) => c.eligible)).toEqual([false, false]);
    expect(result.candidates[1]?.standardApiListPrice).toBeNull();
  });

  it("keeps account and model groups distinct when their identifiers overlap", () => {
    const candidates = [
      { ...candidate, instanceId: "account/model", model: "one" },
      { ...candidate, instanceId: "account", model: "model/one" },
      { ...candidate, instanceId: "other", model: "one" },
    ];
    const rows = candidates.map((selection, index) => row({
      instanceId: selection.instanceId, model: selection.model,
      execution: { ...execution, turnId: `turn-${index}`, durationMs: index * 100 },
    }));
    expect(advise(rows, candidates).candidates.map((entry) => entry.observations.medianObservedExecutionMs)).toEqual([0, 100, 200]);
  });

  it("matches task words against canonical thread titles and falls back to the whole history without one", () => {
    const other = row({ threadId: "other", execution: { ...execution, turnId: "other" } });
    const mine = row({ execution });
    titles.clear();
    expect(advise([mine, other]).scope).toBe("own_dog_history");
    titles.set("thread", "Repair accounts page");
    titles.set("other", "Unrelated errand");
    const matched = advise([mine, other]);
    titles.clear();
    expect(matched.scope).toBe("matching_task_words");
    expect(matched.candidates[0]?.observations.recordedTurns).toBe(1);
    expect(matched.candidates[0]?.evidence.map((item) => item.threadId)).toEqual(["thread"]);
    expect(matched.limitations.join(" ")).toContain("current title");
  });

  it("never matches a legacy row without evidence even when its thread has a matching title", () => {
    titles.set("thread", "Repair accounts");
    const result = advise([row()]);
    titles.clear();
    expect(result.scope).toBe("own_dog_history");
  });
});
