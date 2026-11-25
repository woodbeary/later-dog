export type LineKind = "count" | "ratio";

export interface BudgetLine {
  measure: string;
  label: string;
  kind: LineKind;
  budget: number;
  target: number;
  tolerance?: number;
  unit?: string;
  reference?: string;
}

export interface Budget {
  lines: BudgetLine[];
}

export type Verdict = "pass" | "FAIL";

export interface LineResult {
  line: BudgetLine;
  measured: number | null;
  reference: number | null;
  value: number | null;
  limit: number;
  verdict: Verdict;
  reason: string | null;
  toTarget: number | null;
}

export interface Comparison {
  results: LineResult[];
  ok: boolean;
}

export function limitOf(line: BudgetLine): number {
  return line.budget + (line.tolerance ?? 0);
}

function finite(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function failure(line: BudgetLine, measured: number | null, reference: number | null, reason: string): LineResult {
  return { line, measured, reference, value: null, limit: limitOf(line), verdict: "FAIL", reason, toTarget: null };
}

export function compareLine(line: BudgetLine, measures: Readonly<Record<string, number | undefined>>): LineResult {
  const measured = measures[line.measure];
  if (!finite(measured)) return failure(line, null, null, "not measured");
  if (line.kind === "count") {
    const limit = limitOf(line);
    return { line, measured, reference: null, value: measured, limit, verdict: measured <= limit ? "pass" : "FAIL", reason: measured <= limit ? null : "over budget", toTarget: measured - line.target };
  }
  if (line.reference === undefined) return failure(line, measured, null, "ratio line names no reference");
  const reference = measures[line.reference];
  if (!finite(reference)) return failure(line, measured, null, `reference ${line.reference} not measured`);
  if (reference <= 0) return failure(line, measured, reference, `reference ${line.reference} is not positive`);
  const value = measured / reference;
  const limit = limitOf(line);
  return { line, measured, reference, value, limit, verdict: value <= limit ? "pass" : "FAIL", reason: value <= limit ? null : "over budget", toTarget: value - line.target };
}

export function compare(budget: Budget, measures: Readonly<Record<string, number | undefined>>): Comparison {
  const results = budget.lines.map((line) => compareLine(line, measures));
  return { results, ok: results.length > 0 && results.every((result) => result.verdict === "pass") };
}

function number(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function budgetCell(line: BudgetLine): string {
  const unit = line.kind === "ratio" ? "x" : line.unit ? ` ${line.unit}` : "";
  const tolerance = line.tolerance ? ` (+${number(line.tolerance)})` : "";
  return line.kind === "ratio" ? `<= ${number(line.budget)}${unit}${tolerance}` : `<= ${number(line.budget)}${unit}${tolerance}`;
}

function targetCell(line: BudgetLine): string {
  const unit = line.kind === "ratio" ? "x" : line.unit ? ` ${line.unit}` : "";
  return `${number(line.target)}${unit}`;
}

function measuredCell(result: LineResult): string {
  if (result.measured === null) return "missing";
  const unit = result.line.kind === "ratio" ? "" : result.line.unit ? ` ${result.line.unit}` : "";
  if (result.line.kind === "ratio" && result.value !== null) return `${number(result.value)}x (${number(result.measured)} ms / ${number(result.reference ?? 0)} ms)`;
  return `${number(result.measured)}${unit}`;
}

function toTargetCell(result: LineResult): string {
  if (result.toTarget === null) return "-";
  if (result.toTarget <= 0) return "at target";
  const unit = result.line.kind === "ratio" ? "x" : result.line.unit ? ` ${result.line.unit}` : "";
  return `${number(result.toTarget)}${unit} above`;
}

export function table(comparison: Comparison): string {
  const header = ["Measure", "Budget", "Target", "Measured", "To target", "Verdict"];
  const rows = comparison.results.map((result) => [
    result.line.label,
    budgetCell(result.line),
    targetCell(result.line),
    measuredCell(result),
    toTargetCell(result),
    result.reason === null ? result.verdict : `${result.verdict}: ${result.reason}`,
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]!.length)));
  const render = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  const failed = comparison.results.filter((result) => result.verdict === "FAIL").length;
  const summary = comparison.ok ? `BUDGET: PASS (${comparison.results.length} lines)` : `BUDGET: FAIL (${failed} of ${comparison.results.length} lines)`;
  return [render(header), rule, ...rows.map(render), "", summary].join("\n");
}
