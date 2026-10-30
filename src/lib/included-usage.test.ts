import { describe, expect, it } from "vitest";
import {
  INCLUDED_SERVICE_DEFS,
  amountParts,
  formatAmount,
  formatDay,
  formatDuration,
  formatGrant,
  formatMoney,
  formatTick,
  formatTickUsd,
  niceTicks,
  serviceUsed,
  serviceUsedPercent,
} from "./included-usage";
import { foldRows, stackHeights } from "../components/UsageCharts";
import { periodDays } from "../components/UsageHistory";

const service = (id: string) => INCLUDED_SERVICE_DEFS.find((each) => each.id === id)!;

describe("included usage amounts", () => {
  it("adds up what each service counts and measures it against the tightest limit", () => {
    const used = { ai_tokens: 40_000, grok_tokens: 2_000, decisions: 30, tool_decisions: 90, screen_checks: 5 };
    expect(serviceUsed(used, service("chat"))).toBe(42_000);
    expect(serviceUsed(used, service("review"))).toBe(125);
    expect(serviceUsedPercent(used, { ai_tokens: 200_000 }, service("chat"))).toBe(20);
    expect(serviceUsedPercent(used, { decisions: 300, tool_decisions: 100 }, service("review"))).toBe(90);
    expect(serviceUsedPercent(used, { decisions: 0 }, service("review"))).toBeNull();
    expect(serviceUsedPercent(used, null, service("chat"))).toBeNull();
  });

  it("says amounts in plain units, singular for one", () => {
    expect(formatDuration(28)).toBe("28s");
    expect(formatDuration(90)).toBe("2m");
    expect(formatDuration(3_600)).toBe("1h");
    expect(formatDuration(5_400)).toBe("1h 30m");
    expect(formatAmount(1, "chars")).toBe("1 character");
    expect(formatAmount(1_200, "chars")).toBe("1.2k characters");
    expect(formatAmount(0, "checks")).toBe("0 checks");
    expect(formatAmount(1, "suggestions")).toBe("1 suggestion");
    expect(amountParts(663_000, "tokens")).toEqual({ before: "", count: "663k", after: " tokens" });
  });

  it("writes money so tiny amounts never read as nothing", () => {
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(0.000296)).toBe("<$0.001");
    expect(formatMoney(0.005)).toBe("$0.005");
    expect(formatMoney(0.056614)).toBe("$0.06");
    expect(formatMoney(12.5)).toBe("$12.50");
    expect(formatMoney(5_000)).toBe("$5,000");
    expect(formatMoney(Number.NaN)).toBe("");
  });

  it("writes whole-dollar grants without cents", () => {
    expect(formatGrant(25)).toBe("$25");
    expect(formatGrant(5_000)).toBe("$5,000");
    expect(formatGrant(12.5)).toBe("$12.50");
  });

  it("dates days in UTC", () => {
    expect(formatDay("2026-10-29")).toBe("Oct 29");
    expect(formatDay("soon")).toBe("soon");
  });
});

describe("chart scales", () => {
  it("picks two round steps above the tallest value", () => {
    expect(niceTicks(0, "count")).toEqual([0, 1, 2]);
    expect(niceTicks(1, "count")).toEqual([0, 1, 2]);
    expect(niceTicks(3, "count")).toEqual([0, 2, 4]);
    expect(niceTicks(7, "count")).toEqual([0, 5, 10]);
    expect(niceTicks(45_000, "count")).toEqual([0, 25_000, 50_000]);
    expect(niceTicks(28, "duration")).toEqual([0, 15, 30]);
    expect(niceTicks(5_000, "duration")).toEqual([0, 3_600, 7_200]);
    expect(niceTicks(20_000, "duration")).toEqual([0, 18_000, 36_000]);
    expect(niceTicks(0.0566, "money")).toEqual([0, 0.05, 0.1]);
    expect(niceTicks(0, "money")).toEqual([0, 0.01, 0.02]);
    for (const max of [0.0003, 0.7, 3, 42, 980, 12_345]) {
      const ticks = niceTicks(max, "money");
      expect(ticks[2]).toBeGreaterThanOrEqual(max);
      expect(ticks[1]).toBeLessThan(max * 2 + 1e-9);
    }
  });

  it("labels ticks short", () => {
    expect(formatTickUsd(0)).toBe("$0");
    expect(formatTickUsd(0.0005)).toBe("$0.0005");
    expect(formatTickUsd(0.1)).toBe("$0.10");
    expect(formatTickUsd(2)).toBe("$2");
    expect(formatTickUsd(2.5)).toBe("$2.5");
    expect(formatTickUsd(2_500)).toBe("$2.5k");
    expect(formatTick(0.05 * 3, "money")).toBe("$0.15");
    expect(formatTick(18_000, "duration")).toBe("5h");
    expect(formatTick(25_000, "count")).toBe("25k");
  });
});

describe("chart geometry", () => {
  it("stacks segments to the scale, leaving a 2px gap between them and never less than 2px for a value", () => {
    expect(stackHeights([10, 0, 5], 20, 132)).toEqual([65, 0, 32]);
    expect(stackHeights([0.0001], 100, 132)).toEqual([2]);
    expect(stackHeights([0, 0], 10, 132)).toEqual([0, 0]);
  });

  it("folds rows past the limit into Other, but never a lone row", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ key: `row-${index}`, label: `Row ${index}`, value: 10 - index, valueLabel: String(10 - index) }));
    const folded = foldRows(rows, 7, String);
    expect(folded).toHaveLength(8);
    expect(folded[7]).toMatchObject({ key: "other", label: "Other", value: 5, valueLabel: "5" });
    expect(foldRows(rows.slice(0, 8), 7, String)).toHaveLength(8);
  });

  it("lists every day of a period", () => {
    expect(periodDays({ from: "2026-09-29", to: "2026-10-02" })).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(periodDays({ from: "2026-10-02", to: "2026-10-01" })).toEqual([]);
  });
});
