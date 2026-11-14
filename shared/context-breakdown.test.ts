import { describe, expect, it } from "vitest";

import { contextBreakdownOf, contextRows, type ContextBreakdown } from "./context-breakdown.ts";

const breakdown: ContextBreakdown = {
  at: 10,
  source: "engine",
  total: 198_100,
  window: 1_000_000,
  compactsAt: 967_000,
  parts: [
    { id: "conversation", tokens: 128_800 },
    { id: "tools", tokens: 37_200 },
    { id: "instructions", tokens: 12_500 },
    { id: "skills", tokens: 10_000 },
    { id: "memory", tokens: 6_600 },
    { id: "helpers", tokens: 2_000 },
    { id: "other", tokens: 1_000 },
    { id: "reserve", tokens: 33_000 },
    { id: "free", tokens: 768_900 },
    { id: "tools", tokens: 451_500, deferred: true },
  ],
};

describe("reading a breakdown from the home", () => {
  it("keeps a well-formed answer as it is", () => {
    expect(contextBreakdownOf(JSON.parse(JSON.stringify(breakdown)))).toEqual(breakdown);
  });

  it("refuses part ids outside the closed list and answers that are not sizes", () => {
    expect(contextBreakdownOf({ ...breakdown, parts: [{ id: "Bash", tokens: 3 }] })).toBeNull();
    expect(contextBreakdownOf({ ...breakdown, parts: [{ id: "tools", tokens: -1 }] })).toBeNull();
    expect(contextBreakdownOf({ ...breakdown, source: "guess" })).toBeNull();
    expect(contextBreakdownOf({ ...breakdown, window: 0 })).toBeNull();
    expect(contextBreakdownOf({ error: "nothing yet" })).toBeNull();
    expect(contextBreakdownOf(null)).toBeNull();
  });

  it("drops a compaction point that is not a size", () => {
    expect("compactsAt" in contextBreakdownOf({ ...breakdown, compactsAt: "soon" })!).toBe(false);
  });
});

describe("the rows a person sees", () => {
  it("lists what is used largest first, then the room left, and the tools not loaded apart", () => {
    const rows = contextRows(breakdown);
    expect(rows.used.map((row) => row.id)).toEqual(["conversation", "tools", "instructions", "skills", "memory", "other"]);
    expect(rows.room.map((row) => row.id)).toEqual(["reserve", "free"]);
    expect(rows.notLoaded).toBe(451_500);
    expect(rows.used[0]!.percent).toBeCloseTo(12.88, 2);
  });

  it("folds parts under half a percent into everything else", () => {
    const other = contextRows(breakdown).used.find((row) => row.id === "other")!;
    expect(other.tokens).toBe(3_000);
    expect(contextRows(breakdown).used.some((row) => row.id === "helpers")).toBe(false);
  });

  it("shows no not-loaded line and no room when there is none", () => {
    const rows = contextRows({ ...breakdown, parts: [{ id: "conversation", tokens: 198_100 }] });
    expect(rows.used.map((row) => [row.id, row.tokens])).toEqual([["conversation", 198_100]]);
    expect(rows.used[0]!.percent).toBeCloseTo(19.81, 5);
    expect(rows.room).toEqual([]);
    expect(rows.notLoaded).toBe(0);
  });
});
