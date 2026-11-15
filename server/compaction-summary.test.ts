import { expect, it } from "vitest";
import { deterministicSummary, foldPoint } from "./compaction-summary.ts";
import type { ReplayEntry } from "./context-rebuild.ts";

const history: ReplayEntry[] = [
  { id: "1", role: "user", text: "Deploy release" },
  { id: "2", role: "assistant", text: "Not yet deployed" },
  { id: "3", role: "user", text: "Cancel deployment. Only run tests; value = -5, x != y." },
  { id: "4", role: "assistant", text: "Tests failing: src/test.ts. Work remains unfinished." },
  { id: "5", role: "user", text: "Continue fixing tests" },
  { id: "6", role: "assistant", text: "Working" },
];

it("keeps the last two exchanges and folds only older history", () => {
  expect(foldPoint(history)).toEqual({ folded: history.slice(0, 2), firstKeptId: "3" });
  expect(foldPoint(history.slice(0, 4))).toBeNull();
});

it("preserves corrections, signs, paths and unfinished outcomes without promoting the opening request", () => {
  const summary = deterministicSummary(history);
  expect(summary).toContain("Cancel deployment");
  expect(summary).toContain("-5, x != y");
  expect(summary).toContain("Tests failing: src/test.ts");
  expect(summary).toContain("Work remains unfinished");
  expect(summary).toContain("newer corrections override older requests");
  expect(summary.indexOf("Deploy release")).toBeLessThan(summary.indexOf("Cancel deployment"));
});

it("under pressure keeps recent corrections rather than pinning obsolete instructions", () => {
  const lots: ReplayEntry[] = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, role: "user", text: "old instruction ".repeat(200) }));
  const summary = deterministicSummary([...lots, history[2]!], 1_024);
  expect(summary).toContain("Cancel deployment");
  expect(summary).toContain("earlier excerpts omitted");
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1_024);
});
