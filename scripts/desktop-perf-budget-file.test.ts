import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { limitOf, type Budget } from "./desktop-perf-budget.ts";
import { measures } from "./desktop-perf-measures.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "scripts/desktop-perf.budget.json";

function onMain(): Budget | null {
  try {
    return JSON.parse(execFileSync("git", ["show", `origin/main:${FILE}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Budget;
  } catch {
    return null;
  }
}

const budget = JSON.parse(readFileSync(join(ROOT, FILE), "utf8")) as Budget;

describe("desktop perf budget file", () => {
  it("exists and has lines", () => {
    expect(existsSync(join(ROOT, FILE))).toBe(true);
    expect(budget.lines.length).toBeGreaterThan(0);
  });

  it("names only measures the script can produce", () => {
    const known = new Set(Object.keys(measures));
    for (const line of budget.lines) {
      expect(known.has(line.measure), `${line.measure} is not a measure of desktop-perf.ts`).toBe(true);
      if (line.kind === "ratio") expect(known.has(line.reference ?? ""), `${line.measure} names no known reference`).toBe(true);
    }
  });

  it("names each measure once", () => {
    const names = budget.lines.map((line) => line.measure);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every target at or under its budget", () => {
    for (const line of budget.lines) expect(line.target, line.measure).toBeLessThanOrEqual(limitOf(line));
  });

  it("is never looser than the file on origin/main", (context) => {
    const before = onMain();
    if (before === null) context.skip();
    const now = new Map(budget.lines.map((line) => [line.measure, line]));
    for (const old of before!.lines) {
      const line = now.get(old.measure);
      expect(line, `${old.measure} was dropped from the budget`).toBeDefined();
      expect(line!.kind, `${old.measure} changed kind`).toBe(old.kind);
      expect(limitOf(line!), `${old.measure} is looser than on origin/main`).toBeLessThanOrEqual(limitOf(old));
    }
  });
});
