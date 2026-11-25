import { describe, expect, it } from "vitest";
import { compare, compareLine, limitOf, table, type Budget, type BudgetLine } from "./desktop-perf-budget.ts";

const commits: BudgetLine = { measure: "counted.working.commits", label: "Working turn: commits", kind: "count", budget: 26, target: 1 };
const duration: BudgetLine = { measure: "timed.switchToLongMs.p50", label: "Open the long chat, p50", kind: "ratio", budget: 2, target: 1, reference: "calibration.ms" };

describe("desktop perf budget comparator", () => {
  it("passes a count at or under its budget and fails one over", () => {
    expect(compareLine(commits, { "counted.working.commits": 26 }).verdict).toBe("pass");
    expect(compareLine(commits, { "counted.working.commits": 27 }).verdict).toBe("FAIL");
  });

  it("adds the stated tolerance to the budget", () => {
    const tolerant = { ...commits, tolerance: 2 };
    expect(limitOf(tolerant)).toBe(28);
    expect(compareLine(tolerant, { "counted.working.commits": 28 }).verdict).toBe("pass");
    expect(compareLine(tolerant, { "counted.working.commits": 29 }).verdict).toBe("FAIL");
  });

  it("compares a duration as a ratio to its reference", () => {
    const fast = compareLine(duration, { "timed.switchToLongMs.p50": 150, "calibration.ms": 100 });
    expect(fast.value).toBe(1.5);
    expect(fast.verdict).toBe("pass");
    const slow = compareLine(duration, { "timed.switchToLongMs.p50": 250, "calibration.ms": 100 });
    expect(slow.value).toBe(2.5);
    expect(slow.verdict).toBe("FAIL");
  });

  it("gives the same verdict on a machine twice as slow", () => {
    expect(compareLine(duration, { "timed.switchToLongMs.p50": 300, "calibration.ms": 200 }).verdict).toBe("pass");
  });

  it("fails a measure the run did not produce, never passes it", () => {
    expect(compareLine(commits, {})).toMatchObject({ verdict: "FAIL", reason: "not measured", measured: null });
    expect(compareLine(commits, { "counted.working.commits": Number.NaN }).verdict).toBe("FAIL");
  });

  it("fails a ratio line whose reference is missing, zero or unnamed", () => {
    expect(compareLine(duration, { "timed.switchToLongMs.p50": 100 }).reason).toContain("calibration.ms not measured");
    expect(compareLine(duration, { "timed.switchToLongMs.p50": 100, "calibration.ms": 0 }).verdict).toBe("FAIL");
    expect(compareLine({ ...duration, reference: undefined }, { "timed.switchToLongMs.p50": 100 }).verdict).toBe("FAIL");
  });

  it("reports how far a passing line is from its target", () => {
    expect(compareLine(commits, { "counted.working.commits": 26 }).toTarget).toBe(25);
    expect(compareLine(commits, { "counted.working.commits": 1 }).toTarget).toBe(0);
  });

  it("is ok only when every line holds, and an empty budget is not ok", () => {
    const budget: Budget = { lines: [commits, duration] };
    expect(compare(budget, { "counted.working.commits": 20, "timed.switchToLongMs.p50": 100, "calibration.ms": 100 }).ok).toBe(true);
    expect(compare(budget, { "counted.working.commits": 20, "timed.switchToLongMs.p50": 100 }).ok).toBe(false);
    expect(compare({ lines: [] }, {}).ok).toBe(false);
  });

  it("prints one table with budget, target, measured, distance and verdict", () => {
    const printed = table(compare({ lines: [commits, duration] }, { "counted.working.commits": 30, "timed.switchToLongMs.p50": 150, "calibration.ms": 100 }));
    const rows = printed.split("\n");
    expect(rows[0]).toMatch(/^Measure\s+Budget\s+Target\s+Measured\s+To target\s+Verdict$/);
    expect(printed).toContain("Working turn: commits");
    expect(printed).toMatch(/<= 26\s+1\s+30\s+29 above\s+FAIL: over budget/);
    expect(printed).toMatch(/<= 2x\s+1x\s+1\.5x \(150 ms \/ 100 ms\)\s+0\.5x above\s+pass/);
    expect(printed).toContain("BUDGET: FAIL (1 of 2 lines)");
  });

  it("prints missing next to the line and the pass summary when all hold", () => {
    expect(table(compare({ lines: [commits] }, {}))).toMatch(/missing\s+-\s+FAIL: not measured/);
    expect(table(compare({ lines: [commits] }, { "counted.working.commits": 26 }))).toContain("BUDGET: PASS (1 lines)");
  });
});
