import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { PhonePerformance, phonePerformanceReport } from "./phone-perf.ts";

it("keeps the newest reports privately and refuses oversized or nonfinite measurements", () => {
  const snapshot = { seconds: 1, renders: [], events: 0, eventsPerSecond: 0, framesDropped: 0, longestStallMs: 0, heapMB: null };
  const input = { version: 1, at: 1, dogs: 6, passes: [{ lean: true, switches: 1, switching: snapshot, idle: snapshot, droppedDeltas: 0 }] };
  const report = phonePerformanceReport.parse(input);
  const file = join(mkdtempSync(join(tmpdir(), "phone-performance-kept-")), "phone-perf.json");
  const kept = new PhonePerformance(file, 2);
  for (const at of [1, 2, 3]) kept.record({ ...report, at }, at * 10);
  expect(new PhonePerformance(file).recent().map((row) => [row.at, row.receivedAt])).toEqual([[2, 20], [3, 30]]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(phonePerformanceReport.safeParse({ ...input, passes: [{ ...input.passes[0], switching: { ...snapshot, longestStallMs: Infinity } }] }).success).toBe(false);
  expect(phonePerformanceReport.safeParse({ ...input, passes: [{ ...input.passes[0], switching: { ...snapshot, renders: Array(101).fill({ name: "Message", count: 1, perSecond: 1 }) } }] }).success).toBe(false);
});
