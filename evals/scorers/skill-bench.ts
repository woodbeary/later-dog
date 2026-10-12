import type { ScenarioResult } from "./snapshot.ts";
import type {
  SkillBenchArmRun,
  SkillBenchArmSummary,
  SkillBenchAssertionDelta,
  SkillBenchFixture,
  SkillBenchReport,
} from "../runners/run-skill-bench.ts";

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export function estimateTokens(result: ScenarioResult): number {
  let chars = 0;
  for (const turn of result.evidence.turns) {
    chars += turn.system.length + turn.prompt.length + JSON.stringify(turn.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

function armSummary(runs: SkillBenchArmRun[]): SkillBenchArmSummary {
  const assertionResults = runs.flatMap((run) => run.result.assertions);
  const durations = runs.map((run) => run.result.durationMs);
  const tokens = runs.map((run) => estimateTokens(run.result));
  return {
    runs: runs.length,
    passed: assertionResults.filter((assertion) => assertion.pass).length,
    total: assertionResults.length,
    passRate: assertionResults.length === 0 ? 0 : assertionResults.filter((a) => a.pass).length / assertionResults.length,
    durationMeanMs: mean(durations),
    durationStddevMs: stddev(durations),
    estimatedTokensMean: mean(tokens),
    estimatedTokensStddev: stddev(tokens),
  };
}

function assertionDeltas(bench: SkillBenchFixture, runs: SkillBenchArmRun[]): SkillBenchAssertionDelta[] {
  const deltas: SkillBenchAssertionDelta[] = [];
  for (const prompt of bench.prompts) {
    const promptRuns = runs.filter((run) => run.promptId === prompt.id);
    prompt.assertions.forEach((assertion, index) => {
      const withRuns = promptRuns.filter((run) => run.arm === "with");
      const withoutRuns = promptRuns.filter((run) => run.arm === "without");
      const withPasses = withRuns.filter((run) => run.result.assertions[index]?.pass === true).length;
      const withoutPasses = withoutRuns.filter((run) => run.result.assertions[index]?.pass === true).length;
      const withRate = withRuns.length === 0 ? 0 : withPasses / withRuns.length;
      const withoutRate = withoutRuns.length === 0 ? 0 : withoutPasses / withoutRuns.length;
      let highVariance = false;
      for (const arm of ["with", "without"] as const) {
        const group = promptRuns.filter((run) => run.arm === arm);
        const verdicts = new Set(group.map((run) => run.result.assertions[index]?.pass === true));
        if (group.length >= 2 && verdicts.size > 1) highVariance = true;
      }
      const label = "#" + index + " " + assertion.kind + ("bot" in assertion ? " (" + assertion.bot + ")" : "");
      deltas.push({
        promptId: prompt.id,
        index,
        label,
        withPasses,
        withoutPasses,
        withRuns: withRuns.length,
        withoutRuns: withoutRuns.length,
        withRate,
        withoutRate,
        delta: withRate - withoutRate,
        nonDiscriminating: withRate === withoutRate,
        highVariance,
      });
    });
  }
  return deltas;
}

export function scoreSkillBench(bench: SkillBenchFixture, runs: SkillBenchArmRun[]): SkillBenchReport {
  const assertions = assertionDeltas(bench, runs);
  return {
    fixtureId: bench.id,
    title: bench.title,
    behavior: bench.behavior,
    generatedAt: new Date().toISOString(),
    replicates: bench.replicates,
    prompts: bench.prompts.map((prompt) => ({
      promptId: prompt.id,
      text: prompt.text,
      runs: runs
        .filter((run) => run.promptId === prompt.id)
        .map((run) => ({
          arm: run.arm,
          replicate: run.replicate,
          pass: run.result.pass,
          durationMs: run.result.durationMs,
          estimatedTokens: estimateTokens(run.result),
          failedAssertions: run.result.assertions
            .filter((assertion) => !assertion.pass)
            .map((assertion) => assertion.assertion.kind + ": " + assertion.detail.replaceAll("\n", " ")),
          error: run.result.error,
        })),
    })),
    assertions,
    summary: {
      withSkill: armSummary(runs.filter((run) => run.arm === "with")),
      withoutSkill: armSummary(runs.filter((run) => run.arm === "without")),
      flags: {
        nonDiscriminating: assertions.filter((assertion) => assertion.nonDiscriminating).length,
        highVariance: assertions.filter((assertion) => assertion.highVariance).length,
      },
    },
    errors: runs.filter((run) => run.result.error !== undefined).map((run) => run.promptId + "/" + run.arm + "#" + run.replicate + ": " + run.result.error),
  };
}
