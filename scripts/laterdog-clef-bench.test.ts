import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CLEF_IMAGE_MAX_BYTES } from "../server/laterdog/clef-images.ts";
import { SCREENS_DIR, formatReport, percentile, runClefBench } from "./laterdog-clef-bench.ts";
import { REVIEW_CASES, SCREEN_CASES, TURN_CASES } from "./testing/clef-bench/cases.ts";

describe("the Clef bench fixtures", () => {
  it("has about thirty labelled states covering every label", () => {
    expect(SCREEN_CASES.length + TURN_CASES.length + REVIEW_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(SCREEN_CASES.map((c) => c.showing))).toEqual(new Set(["nothing", "login", "two_factor", "captcha", "error", "dialog"]));
    expect(SCREEN_CASES.some((c) => c.loading)).toBe(true);
    expect(SCREEN_CASES.some((c) => c.secret)).toBe(true);
    expect(new Set(TURN_CASES.map((c) => c.ending))).toEqual(new Set(["done", "question_for_person", "stopped_midway", "blocked"]));
    expect(new Set(REVIEW_CASES.map((c) => c.expect.kind))).toEqual(new Set(["allow", "block", "ask"]));
    const ids = [...SCREEN_CASES, ...TURN_CASES, ...REVIEW_CASES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a screenshot for every screen state, small enough to send", () => {
    const sources = JSON.parse(readFileSync(join(SCREENS_DIR, "..", "sources.json"), "utf8")) as Record<string, { source: string }>;
    for (const testCase of SCREEN_CASES) {
      const file = join(SCREENS_DIR, `${testCase.id}.jpg`);
      expect(existsSync(file), testCase.id).toBe(true);
      expect(statSync(file).size).toBeLessThanOrEqual(CLEF_IMAGE_MAX_BYTES);
      expect(readFileSync(file).subarray(0, 3).toString("hex")).toBe("ffd8ff");
      expect(sources[testCase.id]?.source).toBeTruthy();
    }
  });
});

describe("the Clef bench", () => {
  it("computes median and p95 by nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });

  it("runs dry against the fake backend and reports each question type for both models", async () => {
    const report = await runClefBench({ dry: true, repeat: 2 });
    expect(report.dry).toBe(true);
    const keys = report.rows.map((row) => `${row.model}/${row.call}/${row.question}`);
    expect([...keys].sort()).toEqual([
      "clef/autoReview/verdict", "clef/screenCheck/loading", "clef/screenCheck/showing", "clef/screenshotFilter/secret", "clef/screenshotFilter/worth", "clef/turnEnd/ending",
      "clef-flash/autoReview/verdict", "clef-flash/screenCheck/loading", "clef-flash/screenCheck/showing", "clef-flash/screenshotFilter/secret", "clef-flash/screenshotFilter/worth", "clef-flash/turnEnd/ending",
    ].sort());
    for (const row of report.rows) {
      expect(row.runs).toBeGreaterThan(0);
      expect(row.accuracy).toBeGreaterThan(0.5);
      expect(row.accuracy).toBeLessThan(1);
      expect(row.medianMs).not.toBeNull();
      expect(row.p95Ms!).toBeGreaterThanOrEqual(row.medianMs!);
      expect(row.failures).toEqual({});
    }
    const median = (model: string) => report.rows.find((row) => row.model === model && row.call === "turnEnd")!.medianMs!;
    expect(median("clef-flash")).toBeLessThan(median("clef"));
    expect(formatReport(report)).toContain("DRY RUN");
  });

  it("can run one call type for one model", async () => {
    const report = await runClefBench({ dry: true, repeat: 1, models: ["clef-flash"], only: ["turnEnd"] });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ model: "clef-flash", call: "turnEnd", question: "ending", runs: TURN_CASES.length });
  });

  it("refuses a live run without LATERDOG_DECIDER_URL and LATERDOG_DECIDER_KEY", async () => {
    await expect(runClefBench({ repeat: 1 })).rejects.toThrow("LATERDOG_DECIDER_URL");
  });

  it("the command line reads the endpoint from the environment only and runs dry without any", () => {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", join(SCREENS_DIR, "..", "..", "..", "laterdog-clef-bench.ts"), "--dry", "--repeat", "1", "--models", "clef-flash"], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(output).toContain("DRY RUN");
    expect(output).toContain("clef-flash");
  });
});
