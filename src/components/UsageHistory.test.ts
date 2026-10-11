import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { USAGE_GROUPINGS, UsageHistoryTable, usageExportHref, usagePeriodRange, type UsageSummary } from "./UsageHistory";

const group = (key: string, label: string, over: Partial<UsageSummary["groups"][number]> = {}) => ({
  key, label, turns: 3, input: 12_000, output: 2_000, cachedInput: 9_000, costUsd: 0.42, unpriced: 0, ...over,
});

describe("usage history table", () => {
  it("counts new tokens without a paragraph about the cache", () => {
    const total = group("total", "total", { input: 499_000_000, output: 600_000, cachedInput: 497_500_000 });
    const summary: UsageSummary = { from: "2026-09-01", to: "2026-09-30", groupBy: "bot", groups: [total], total };
    const html = renderToStaticMarkup(createElement(UsageHistoryTable, { summary }));
    expect(html).toContain("New tokens");
    expect(html).toContain("2.1M");
    expect(html).not.toContain("went through the model");
  });

  it("lists each dog by name and flags turns on a model with no price", () => {
    const summary: UsageSummary = {
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z", groupBy: "bot",
      groups: [
        group("bot:atlas", "Atlas"),
        group("bot:juniper", "Juniper", { costUsd: null, unpriced: 3 }),
      ],
      total: group("total", "total", { turns: 6, costUsd: 0.42, unpriced: 3 }),
    };
    const html = renderToStaticMarkup(createElement(UsageHistoryTable, { summary }));
    expect(html).toContain(">Dog<");
    expect(html).toContain("Atlas");
    expect(html).toContain("Juniper");
    expect(html).toContain("3 turn(s) used a model with no known price");
    expect(html).toContain("$0.42");
    expect(html).not.toContain("~");
    expect(html).not.toContain("Billable");
  });

  it("marks costs that include an estimate and says how much of the period is estimated", () => {
    const summary: UsageSummary = {
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z", groupBy: "model",
      groups: [group("model:gpt-5", "gpt-5", { costUsd: 0.8, estimatedUsd: 0.8 }), group("model:opus", "opus", { estimatedUsd: null })],
      total: group("total", "total", { turns: 6, costUsd: 1.22, estimatedUsd: 0.8 }),
    };
    const html = renderToStaticMarkup(createElement(UsageHistoryTable, { summary }));
    expect(html).toContain(">Model<");
    expect(html).toContain("$0.80 of this is estimated");
    expect(html.match(/>~</g)).toHaveLength(2);
    expect(html).toContain("$0.80 in this period is priced from list prices");
  });

  it("says so when the period is empty", () => {
    const summary: UsageSummary = { from: "", to: "", groupBy: "bot", groups: [], total: group("total", "total", { turns: 0, costUsd: null }) };
    expect(renderToStaticMarkup(createElement(UsageHistoryTable, { summary }))).toContain("Nothing recorded in this period.");
  });
});

describe("usage history helpers", () => {
  it("computes inclusive UTC day bounds for each preset", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(usagePeriodRange("month", now)).toEqual({ from: "2026-09-01", to: "2026-09-15" });
    expect(usagePeriodRange("lastMonth", now)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(usagePeriodRange("days30", now)).toEqual({ from: "2026-08-17", to: "2026-09-15" });
    expect(usagePeriodRange("lastMonth", new Date("2026-01-10T00:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("groups by dog, model or day, and exports the period", () => {
    expect(USAGE_GROUPINGS).toEqual(["bot", "model", "day"]);
    expect(usageExportHref({ from: "2026-09-01", to: "2026-09-30" })).toBe("/api/usage.csv?from=2026-09-01&to=2026-09-30");
  });
});
