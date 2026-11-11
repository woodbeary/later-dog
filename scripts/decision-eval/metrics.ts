export interface Graded {
  id: string;
  correct: boolean;
  confidence: number;
}

export interface ReliabilityBin {
  from: number;
  to: number;
  count: number;
  meanConfidence: number | null;
  accuracy: number | null;
}

export interface AbstainPoint {
  threshold: number;
  answered: number;
  coverage: number;
  accuracyWhenAnswered: number | null;
  wrongWhenAnswered: number;
}

export const RELIABILITY_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1] as const;
export const ABSTAIN_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const;

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

export function accuracy(rows: readonly Graded[]): number | null {
  return mean(rows.map((row) => (row.correct ? 1 : 0)));
}

export function brier(rows: readonly Graded[]): number | null {
  return mean(rows.map((row) => (row.confidence - (row.correct ? 1 : 0)) ** 2));
}

export function reliability(rows: readonly Graded[], edges: readonly number[] = RELIABILITY_EDGES): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index]!;
    const to = edges[index + 1]!;
    const last = index === edges.length - 2;
    const inside = rows.filter((row) => row.confidence >= from && (last ? row.confidence <= to : row.confidence < to));
    bins.push({
      from,
      to,
      count: inside.length,
      meanConfidence: mean(inside.map((row) => row.confidence)),
      accuracy: accuracy(inside),
    });
  }
  return bins;
}

export function expectedCalibrationError(rows: readonly Graded[], edges: readonly number[] = RELIABILITY_EDGES): number | null {
  if (!rows.length) return null;
  return reliability(rows, edges).reduce(
    (total, bin) => total + (bin.count / rows.length) * Math.abs((bin.accuracy ?? 0) - (bin.meanConfidence ?? 0)),
    0,
  );
}

export function abstainSweep(rows: readonly Graded[], thresholds: readonly number[] = ABSTAIN_THRESHOLDS): AbstainPoint[] {
  return thresholds.map((threshold) => {
    const answered = rows.filter((row) => row.confidence >= threshold);
    return {
      threshold,
      answered: answered.length,
      coverage: rows.length ? answered.length / rows.length : 0,
      accuracyWhenAnswered: accuracy(answered),
      wrongWhenAnswered: answered.filter((row) => !row.correct).length,
    };
  });
}

export function accuracyWithFallback(
  ids: readonly string[],
  model: ReadonlyMap<string, Graded>,
  ruleCorrect: ReadonlyMap<string, boolean>,
  threshold: number,
): number | null {
  return mean(ids.map((id) => {
    const row = model.get(id);
    const useModel = row !== undefined && row.confidence >= threshold;
    return (useModel ? row.correct : ruleCorrect.get(id) === true) ? 1 : 0;
  }));
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

export function latencySummary(values: readonly number[], budgetMs: number) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    worst: percentile(values, 1),
    overBudget: values.filter((value) => value > budgetMs).length,
  };
}

export function costPerThousand(inputTokens: readonly number[], dollarsPerMillionInput: number): number | null {
  const average = mean(inputTokens);
  return average === null ? null : (average * 1000 * dollarsPerMillionInput) / 1_000_000;
}

export function reciprocalRank(probabilities: Readonly<Record<string, number>>, gold: string): number {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const position = ranked.indexOf(gold);
  return position < 0 ? 0 : 1 / (position + 1);
}
