import {
  DECISION_CASES, DOLLARS_PER_MILLION_INPUT, decisionItems, gradeDecision, ruleCorrect, type DecisionCase, type DecisionItem,
} from "./cases.ts";
import {
  EXTRACTION_MODEL, RESET_FIELDS, SHORT_TEXT_FIELDS, calendarDate, clockTime, extractionFixture, parseExtraction, resetWallClock,
  ruleResetWallClock, ruleShortText, sameNumber, spanSupports, type ExtractedValue, type FieldSpec,
} from "./extraction.ts";
import {
  ABSTAIN_THRESHOLDS, abstainSweep, accuracy, accuracyWithFallback, brier, costPerThousand, expectedCalibrationError, latencySummary,
  reliability, type AbstainPoint, type Graded, type ReliabilityBin,
} from "./metrics.ts";

export const DECISION_BUDGET_MS = 1_500;
export const NULL_THRESHOLDS = [0.05, 0.1, 0.3, 0.5, 0.7, 0.9] as const;
export const LATENCY_MARKS_MS = [100, 250, 500, 1_000, 1_500] as const;
export const WAIT_TOLERANCE = 0.01;

export interface Receipt {
  id: string;
  group: string;
  model: string;
  item: string;
  target: string;
  at: string;
  latencyMs: number;
  status?: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type Latency = ReturnType<typeof latencySummary>;

export interface DecisionScore {
  case: DecisionCase;
  model: string;
  target: string;
  asked: number;
  failed: number;
  invalid: number;
  failures: Record<string, number>;
  scored: number;
  accuracy: number | null;
  ruleAccuracy: number | null;
  brier: number | null;
  calibrationError: number | null;
  reliability: ReliabilityBin[];
  abstain: AbstainPoint[];
  withRuleFallback: Array<{ threshold: number; accuracy: number | null }>;
  unscored: { count: number; atOrAbove06: number };
  primaryAccuracy: number | null;
  meanReciprocalRank: number | null;
  latency: Latency;
  meanInputTokens: number | null;
  dollarsPerThousand: number | null;
  wrong: Array<{ item: string; confidence: number }>;
}

type Outcome = "correct" | "wrong" | "missed" | "falseValue" | "correctNull";
type Tally = Record<Outcome, number>;

export interface ExtractionScore {
  target: string;
  asked: number;
  failed: number;
  invalid: number;
  latency: Latency;
  meanInputTokens: number | null;
  dollarsPerThousand: number | null;
  resetTime: {
    items: number;
    model: Tally;
    rule: Tally;
    ruleThenModel: Tally;
    fields: Array<{ field: string; tally: Tally }>;
    waitWithinTolerance: number;
    nullThresholds: Array<{ threshold: number; tally: Tally }>;
    wrong: Array<{ item: string; got: string | null; want: string | null; confidence: number | null }>;
  };
  shortText: { items: number; amount: { model: Tally; rule: Tally }; date: { model: Tally; rule: Tally }; amountsWrittenInTheText: number; amountsReturned: number; wrong: string[] };
  computed: { items: number; correct: number; wrong: string[]; estimates: number; estimateCovers: number; estimateWithinStep: number };
  evidence: { textAnswers: number; spanReturned: number; spanSupportsValue: number; spanSupportsRightValue: number; typedAnswers: number; typedWithSpan: number };
  confidence: { whenRight: number | null; whenWrong: number | null };
}

export interface ModelLatency {
  model: string;
  target: string;
  latency: Latency;
  within: Array<{ ms: number; share: number }>;
}

export interface Results {
  receipts: Array<{ target: string; calls: number; first: string; last: string }>;
  latency: ModelLatency[];
  rules: Array<{ case: DecisionCase; scored: number; accuracy: number | null }>;
  decisions: DecisionScore[];
  extraction: ExtractionScore[];
}

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const inputTokens = (result: unknown): number | null => {
  const usage = isRecord(result) && isRecord(result.usage) ? result.usage.input_tokens : undefined;
  return typeof usage === "number" && Number.isFinite(usage) ? usage : null;
};
const emptyTally = (): Tally => ({ correct: 0, wrong: 0, missed: 0, falseValue: 0, correctNull: 0 });

function outcome<T>(got: T | null, want: T | null, same: (a: T, b: T) => boolean): Outcome {
  if (want === null) return got === null ? "correctNull" : "falseValue";
  if (got === null) return "missed";
  return same(got, want) ? "correct" : "wrong";
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const name = key(row);
    const group = groups.get(name);
    if (group) group.push(row);
    else groups.set(name, [row]);
  }
  return groups;
}

function scoreDecisions(receipts: readonly Receipt[], items: readonly DecisionItem[]): DecisionScore[] {
  const byId = new Map(items.map((item) => [`${item.group}:${item.id}`, item]));
  const scores: DecisionScore[] = [];
  const wanted = receipts.filter((row) => (DECISION_CASES as readonly string[]).includes(row.group));
  for (const [key, rows] of groupBy(wanted, (row) => `${row.target}\0${row.model}\0${row.group}`)) {
    const [target, model, group] = key.split("\0") as [string, string, DecisionCase];
    const graded = new Map<string, Graded>();
    const failures: Record<string, number> = {};
    const reciprocalRanks: number[] = [];
    const primary: number[] = [];
    const tokens: number[] = [];
    let invalid = 0;
    let unscored = 0;
    let unscoredConfident = 0;
    for (const row of rows) {
      const item = byId.get(`${row.group}:${row.item}`);
      if (!item) continue;
      if (!row.ok) {
        const reason = row.error === "timeout" ? "timeout" : row.status ? `http ${row.status}` : row.error ?? "failed";
        failures[reason] = (failures[reason] ?? 0) + 1;
        continue;
      }
      const grade = gradeDecision(item, row.result);
      if (!grade.ok) {
        invalid += 1;
        continue;
      }
      const used = inputTokens(row.result);
      if (used !== null) tokens.push(used);
      if (!grade.graded) {
        unscored += 1;
        if (grade.confidence >= 0.6) unscoredConfident += 1;
        continue;
      }
      graded.set(item.id, grade.graded);
      if (grade.reciprocalRank !== undefined) reciprocalRanks.push(grade.reciprocalRank);
      if (grade.primaryCorrect !== undefined) primary.push(grade.primaryCorrect ? 1 : 0);
    }
    const caseItems = items.filter((item) => item.group === group && item.gold.kind !== "unscored");
    const ruleById = new Map(caseItems.map((item) => [item.id, ruleCorrect(item) === true]));
    const gradedRows = [...graded.values()];
    const price = DOLLARS_PER_MILLION_INPUT[model as keyof typeof DOLLARS_PER_MILLION_INPUT];
    scores.push({
      case: group,
      model,
      target,
      asked: rows.length,
      failed: Object.values(failures).reduce((total, count) => total + count, 0),
      invalid,
      failures,
      scored: gradedRows.length,
      accuracy: accuracy(gradedRows),
      ruleAccuracy: mean(caseItems.map((item) => (ruleById.get(item.id) ? 1 : 0))),
      brier: brier(gradedRows),
      calibrationError: expectedCalibrationError(gradedRows),
      reliability: reliability(gradedRows),
      abstain: abstainSweep(gradedRows),
      withRuleFallback: ABSTAIN_THRESHOLDS.map((threshold) => ({
        threshold,
        accuracy: accuracyWithFallback(caseItems.map((item) => item.id), graded, ruleById, threshold),
      })),
      unscored: { count: unscored, atOrAbove06: unscoredConfident },
      primaryAccuracy: mean(primary),
      meanReciprocalRank: mean(reciprocalRanks),
      latency: latencySummary(rows.filter((row) => row.ok).map((row) => row.latencyMs), DECISION_BUDGET_MS),
      meanInputTokens: mean(tokens),
      dollarsPerThousand: price === undefined ? null : costPerThousand(tokens, price),
      wrong: gradedRows.filter((row) => !row.correct).map((row) => ({ item: row.id, confidence: Number(row.confidence.toFixed(3)) })),
    });
  }
  return scores.sort((a, b) => `${a.case}${a.target}${a.model}`.localeCompare(`${b.case}${b.target}${b.model}`));
}

const sameText = (a: string, b: string) => a === b;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const text = (value: string | number | null): string | null => (typeof value === "string" ? value : null);
const number = (value: string | number | null): number | null => (typeof value === "number" ? value : null);

export function writtenInText(value: number, source: string): boolean {
  const digits = source.replace(/(\d),(?=\d{3})/g, "$1");
  const whole = Number.isInteger(value) ? String(value) : null;
  const forms = [String(value), value.toFixed(2), ...(whole ? [whole] : [])];
  return forms.some((form) => new RegExp(`(?:^|[^\\d.])${form.replace(".", "\\.")}(?:\\.0+)?(?![\\d]|\\.\\d)`).test(digits));
}

function latencyByModel(receipts: readonly Receipt[]): ModelLatency[] {
  return [...groupBy(receipts.filter((row) => row.ok), (row) => `${row.target}\0${row.model}`)].map(([key, rows]) => {
    const [target, model] = key.split("\0") as [string, string];
    const values = rows.map((row) => row.latencyMs);
    return {
      model,
      target,
      latency: latencySummary(values, DECISION_BUDGET_MS),
      within: LATENCY_MARKS_MS.map((ms) => ({ ms, share: values.filter((value) => value <= ms).length / values.length })),
    };
  });
}

function zoneFor(answer: ExtractedValue | undefined, item: { zone: string | null; zoneId: string }, homeZone: string): string {
  if (item.zone === null) return item.zoneId;
  const named = typeof answer?.value === "string" ? answer.value.toLowerCase() : "";
  return named && (named.includes(item.zone.toLowerCase()) || item.zone.toLowerCase().includes(named)) ? item.zoneId : homeZone;
}

function withNullThreshold(answer: ExtractedValue, threshold: number): ExtractedValue {
  if (answer.pNull === null) return answer;
  return { ...answer, value: answer.pNull > threshold ? null : answer.guess ?? answer.value };
}

function scoreExtraction(receipts: readonly Receipt[]): ExtractionScore[] {
  const fixture = extractionFixture();
  const nowMs = Date.parse(fixture.now);
  process.env.TZ = fixture.homeZone;
  const referenceYear = Number(fixture.now.slice(0, 4));
  const scores: ExtractionScore[] = [];
  const wanted = receipts.filter((row) => row.model === EXTRACTION_MODEL);
  for (const [target, rows] of groupBy(wanted, (row) => row.target)) {
    const byItem = new Map(rows.map((row) => [`${row.group}:${row.item}`, row]));
    const tokens: number[] = [];
    const rightConfidence: number[] = [];
    const wrongConfidence: number[] = [];
    const evidence = { textAnswers: 0, spanReturned: 0, spanSupportsValue: 0, spanSupportsRightValue: 0, typedAnswers: 0, typedWithSpan: 0 };
    let invalid = 0;
    const read = (group: string, id: string, fields: Record<string, FieldSpec>) => {
      const row = byItem.get(`${group}:${id}`);
      if (!row?.ok) return null;
      const parsed = parseExtraction(row.result, fields);
      if (!parsed.ok) {
        invalid += 1;
        return null;
      }
      if (parsed.inputTokens !== null) tokens.push(parsed.inputTokens);
      for (const [name, spec] of Object.entries(fields)) {
        const answer = parsed.answers[name]!;
        if (answer.value === null) continue;
        if (spec.type === "text") {
          evidence.textAnswers += 1;
          if (answer.span) evidence.spanReturned += 1;
          if (spanSupports(answer, parsed.stateText)) evidence.spanSupportsValue += 1;
        } else {
          evidence.typedAnswers += 1;
          if (answer.span) evidence.typedWithSpan += 1;
        }
      }
      return parsed;
    };
    const note = (answer: ExtractedValue | undefined, result: Outcome) => {
      if (answer?.confidence === null || answer?.confidence === undefined) return;
      if (result === "correct") rightConfidence.push(answer.confidence);
      if (result === "wrong" || result === "falseValue") wrongConfidence.push(answer.confidence);
    };

    const resetFields = { reset_time: emptyTally(), reset_date: emptyTally(), time_zone: emptyTally(), wait: emptyTally() };
    const reset = {
      items: fixture.resets.length, model: emptyTally(), rule: emptyTally(), ruleThenModel: emptyTally(),
      fields: Object.entries(resetFields).map(([field, tally]) => ({ field, tally })), waitWithinTolerance: 0,
      nullThresholds: NULL_THRESHOLDS.map((threshold) => ({ threshold, tally: emptyTally() })), wrong: [] as ExtractionScore["resetTime"]["wrong"],
    };
    for (const item of fixture.resets) {
      const ruled = ruleResetWallClock(item, nowMs);
      reset.rule[outcome(ruled, item.local, sameText)] += 1;
      const parsed = read("resetTime", item.id, RESET_FIELDS);
      if (!parsed) {
        reset.ruleThenModel[outcome(ruled, item.local, sameText)] += 1;
        continue;
      }
      resetFields.reset_time[outcome(clockTime(parsed.answers.reset_time!.value), item.time, sameText)] += 1;
      resetFields.reset_date[outcome(calendarDate(parsed.answers.reset_date!.value), item.date, sameText)] += 1;
      const zoneResult = outcome(text(parsed.answers.time_zone!.value), item.zone, sameName);
      resetFields.time_zone[zoneResult] += 1;
      if (zoneResult === "correct" && spanSupports(parsed.answers.time_zone!, parsed.stateText)) evidence.spanSupportsRightValue += 1;
      const waited = number(parsed.answers.wait!.value);
      resetFields.wait[outcome(waited, item.waitSeconds, sameNumber)] += 1;
      if (waited !== null && item.waitSeconds !== null && Math.abs(waited - item.waitSeconds) <= item.waitSeconds * WAIT_TOLERANCE) reset.waitWithinTolerance += 1;
      const assemble = (answers: Record<string, ExtractedValue>) => resetWallClock({
        time: clockTime(answers.reset_time!.value),
        date: calendarDate(answers.reset_date!.value),
        waitSeconds: typeof answers.wait!.value === "number" ? answers.wait!.value : null,
      }, zoneFor(answers.time_zone, item, fixture.homeZone), nowMs);
      const got = assemble(parsed.answers);
      const result = outcome(got, item.local, sameText);
      reset.model[result] += 1;
      reset.ruleThenModel[outcome(ruled ?? got, item.local, sameText)] += 1;
      note(parsed.answers.reset_time, result);
      if (result !== "correct" && result !== "correctNull") {
        reset.wrong.push({ item: item.id, got, want: item.local, confidence: parsed.answers.reset_time!.confidence });
      }
      for (const point of reset.nullThresholds) {
        const adjusted = Object.fromEntries(Object.entries(parsed.answers).map(([name, answer]) => [name, withNullThreshold(answer, point.threshold)]));
        point.tally[outcome(assemble(adjusted), item.local, sameText)] += 1;
      }
    }

    const short = { items: fixture.shortTexts.length, amount: { model: emptyTally(), rule: emptyTally() }, date: { model: emptyTally(), rule: emptyTally() }, amountsWrittenInTheText: 0, amountsReturned: 0, wrong: [] as string[] };
    for (const item of fixture.shortTexts) {
      const rule = ruleShortText(item.text, referenceYear);
      short.amount.rule[outcome(rule.amount, item.amount, sameNumber)] += 1;
      short.date.rule[outcome(rule.date, item.date, sameText)] += 1;
      const parsed = read("shortText", item.id, SHORT_TEXT_FIELDS);
      if (!parsed) continue;
      const amount = typeof parsed.answers.amount!.value === "number" ? parsed.answers.amount!.value : null;
      const amountResult = outcome(amount, item.amount, sameNumber);
      if (amount !== null) {
        short.amountsReturned += 1;
        if (writtenInText(amount, item.text)) short.amountsWrittenInTheText += 1;
      }
      const dateResult = outcome(calendarDate(parsed.answers.date!.value), item.date, sameText);
      short.amount.model[amountResult] += 1;
      short.date.model[dateResult] += 1;
      note(parsed.answers.amount, amountResult);
      note(parsed.answers.date, dateResult);
      if (amountResult !== "correct" && amountResult !== "correctNull") short.wrong.push(`${item.id} amount ${amountResult}`);
      if (dateResult !== "correct" && dateResult !== "correctNull") short.wrong.push(`${item.id} date ${dateResult}`);
    }

    const computed = { items: fixture.computed.length, correct: 0, wrong: [] as string[], estimates: 0, estimateCovers: 0, estimateWithinStep: 0 };
    for (const item of fixture.computed) {
      const fields: Record<string, FieldSpec> = {
        value: item.field,
        ...(item.estimate ? { estimated: { type: "estimate" as const, ...item.estimate } } : {}),
      };
      const parsed = read("computed", item.id, fields);
      if (!parsed) continue;
      const answer = parsed.answers.value!;
      const right = typeof item.gold === "number"
        ? typeof answer.value === "number" && sameNumber(answer.value, item.gold)
        : (item.field.type === "time" ? clockTime(answer.value) : calendarDate(answer.value)) === item.gold;
      if (right) computed.correct += 1;
      else computed.wrong.push(`${item.id} got ${String(answer.value)}`);
      note(answer, right ? "correct" : "wrong");
      const estimated = parsed.answers.estimated;
      if (item.estimate && estimated && typeof item.gold === "number") {
        computed.estimates += 1;
        if (estimated.p10 !== null && estimated.p90 !== null && estimated.p10 <= item.gold && item.gold <= estimated.p90) computed.estimateCovers += 1;
        if (typeof estimated.value === "number" && Math.abs(estimated.value - item.gold) <= item.estimate.step) computed.estimateWithinStep += 1;
      }
    }

    scores.push({
      target,
      asked: rows.length,
      failed: rows.filter((row) => !row.ok).length,
      invalid,
      latency: latencySummary(rows.filter((row) => row.ok).map((row) => row.latencyMs), DECISION_BUDGET_MS),
      meanInputTokens: mean(tokens),
      dollarsPerThousand: costPerThousand(tokens, DOLLARS_PER_MILLION_INPUT.clairic),
      resetTime: reset,
      shortText: short,
      computed,
      evidence,
      confidence: { whenRight: mean(rightConfidence), whenWrong: mean(wrongConfidence) },
    });
  }
  return scores;
}

export function scoreAll(receipts: readonly Receipt[]): Results {
  const items = decisionItems();
  return {
    receipts: [...groupBy(receipts, (row) => row.target)].map(([target, rows]) => {
      const times = rows.map((row) => row.at).sort();
      return { target, calls: rows.length, first: times[0] ?? "", last: times.at(-1) ?? "" };
    }),
    latency: latencyByModel(receipts),
    rules: DECISION_CASES.map((group) => {
      const scored = items.filter((item) => item.group === group && item.gold.kind !== "unscored");
      return { case: group, scored: scored.length, accuracy: mean(scored.map((item) => (ruleCorrect(item) ? 1 : 0))) };
    }),
    decisions: scoreDecisions(receipts, items),
    extraction: scoreExtraction(receipts),
  };
}

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const fixed = (value: number | null, digits = 3) => (value === null ? "n/a" : value.toFixed(digits));
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
const tally = (value: Tally) => `${value.correct + value.correctNull} right (${value.correctNull} of them correctly empty), ${value.wrong} wrong value, ${value.falseValue} value where none exists, ${value.missed} missed`;

export function renderMarkdown(results: Results): string {
  const parts: string[] = [];
  parts.push(table(["Receipts from", "Calls", "First", "Last"], results.receipts.map((row) => [row.target, String(row.calls), row.first, row.last])));
  parts.push(table(
    ["Model", "Path", "Answered", "p50 ms", "p95 ms", "Worst ms", ...LATENCY_MARKS_MS.map((ms) => `Within ${ms} ms`)],
    results.latency.map((row) => [
      row.model, row.target, String(row.latency.count), String(row.latency.p50 ?? "n/a"), String(row.latency.p95 ?? "n/a"), String(row.latency.worst ?? "n/a"),
      ...row.within.map((mark) => percent(mark.share)),
    ]),
  ));
  parts.push(table(
    ["Case", "Model", "Path", "Scored", "Right", "Rule", "Brier", "Calibration gap", "p50 ms", "p95 ms", "Worst ms", `Over ${DECISION_BUDGET_MS} ms`, "Failed", "Invalid", "$ per 1,000"],
    results.decisions.map((row) => [
      row.case, row.model, row.target, String(row.scored), percent(row.accuracy), percent(row.ruleAccuracy), fixed(row.brier), fixed(row.calibrationError),
      String(row.latency.p50 ?? "n/a"), String(row.latency.p95 ?? "n/a"), String(row.latency.worst ?? "n/a"), String(row.latency.overBudget),
      String(row.failed), String(row.invalid), fixed(row.dollarsPerThousand, 4),
    ]),
  ));
  for (const row of results.decisions) {
    parts.push(`${row.case}, ${row.model}, ${row.target}`);
    parts.push(table(
      ["Confidence", "Answers", "Mean confidence", "Right"],
      row.reliability.filter((bin) => bin.count > 0).map((bin) => [`${bin.from} to ${bin.to}`, String(bin.count), fixed(bin.meanConfidence), percent(bin.accuracy)]),
    ));
    parts.push(table(
      ["Answer only at or above", "Answered", "Right when answered", "Wrong when answered", "Right with the rule for the rest"],
      row.abstain.map((point, index) => [
        String(point.threshold), `${point.answered} (${percent(point.coverage)})`, percent(point.accuracyWhenAnswered), String(point.wrongWhenAnswered),
        percent(row.withRuleFallback[index]?.accuracy ?? null),
      ]),
    ));
    if (row.meanReciprocalRank !== null) parts.push(`First choice is the primary dog ${percent(row.primaryAccuracy)}; mean reciprocal rank ${fixed(row.meanReciprocalRank)}.`);
    if (row.unscored.count) parts.push(`Messages meant for nobody: ${row.unscored.count}, of which ${row.unscored.atOrAbove06} were answered at 0.6 or above.`);
    if (row.wrong.length) parts.push(`Wrong: ${row.wrong.map((wrong) => `${wrong.item} (${wrong.confidence})`).join(", ")}`);
  }
  for (const row of results.extraction) {
    parts.push(`Extraction, ${row.target}: ${row.asked} calls, ${row.failed} failed, ${row.invalid} invalid; p50 ${row.latency.p50} ms, p95 ${row.latency.p95} ms, worst ${row.latency.worst} ms; ${fixed(row.meanInputTokens, 0)} input tokens a call, $${fixed(row.dollarsPerThousand, 4)} per 1,000.`);
    parts.push(table([`Reset time, ${row.resetTime.items} messages`, "Result"], [
      ["Model", tally(row.resetTime.model)],
      ["Rule", tally(row.resetTime.rule)],
      ["Rule, then the model where the rule finds nothing", tally(row.resetTime.ruleThenModel)],
      ...row.resetTime.nullThresholds.map((point) => [`Model, empty above ${point.threshold}`, tally(point.tally)]),
    ]));
    parts.push(table(["Reset field", "Result"], row.resetTime.fields.map((field) => [field.field, tally(field.tally)])));
    parts.push(`Waits within ${WAIT_TOLERANCE * 100}% of the labelled seconds: ${row.resetTime.waitWithinTolerance}.`);
    if (row.resetTime.wrong.length) parts.push(`Reset misses: ${row.resetTime.wrong.map((wrong) => `${wrong.item} got ${wrong.got ?? "nothing"} want ${wrong.want ?? "nothing"} (${fixed(wrong.confidence, 2)})`).join("; ")}`);
    parts.push(table([`Short text, ${row.shortText.items} messages`, "Model", "Rule"], [
      ["Amount", tally(row.shortText.amount.model), tally(row.shortText.amount.rule)],
      ["Date", tally(row.shortText.date.model), tally(row.shortText.date.rule)],
    ]));
    if (row.shortText.wrong.length) parts.push(`Short text misses: ${row.shortText.wrong.join("; ")}`);
    parts.push(`Computed values: ${row.computed.correct} of ${row.computed.items} right. Estimates: ${row.computed.estimateCovers} of ${row.computed.estimates} had the true value between the 10th and 90th percentile, ${row.computed.estimateWithinStep} landed within one step.`);
    if (row.computed.wrong.length) parts.push(`Computed misses: ${row.computed.wrong.join("; ")}`);
    parts.push(`Evidence: ${row.evidence.spanSupportsValue} of ${row.evidence.textAnswers} text answers came with a span that reads back as the value (${row.evidence.spanReturned} had a span), and ${row.evidence.spanSupportsRightValue} of those were the right value; ${row.evidence.typedWithSpan} of ${row.evidence.typedAnswers} typed answers carried a span. ${row.shortText.amountsWrittenInTheText} of ${row.shortText.amountsReturned} amounts returned are written as digits in the text.`);
    parts.push(`Mean reported confidence: ${fixed(row.confidence.whenRight)} when right, ${fixed(row.confidence.whenWrong)} when wrong.`);
  }
  return `${parts.join("\n\n")}\n`;
}
