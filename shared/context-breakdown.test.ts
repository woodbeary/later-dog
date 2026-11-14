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

  it("folds a part id it does not know into everything else", () => {
    const one = contextBreakdownOf({ ...breakdown, parts: [{ id: "conversation", tokens: 128_800 }, { id: "added_later", tokens: 6_000 }, { id: "free", tokens: 865_200 }] })!;
    expect(one.parts).toEqual([{ id: "conversation", tokens: 128_800 }, { id: "other", tokens: 6_000 }, { id: "free", tokens: 865_200 }]);
    expect(contextRows(one).used.map((row) => [row.id, row.tokens])).toEqual([["conversation", 128_800], ["other", 6_000]]);
    const all = contextBreakdownOf({ ...breakdown, parts: [{ id: "new_a", tokens: 100_000 }, { id: "new_b", tokens: 98_100 }] })!;
    expect(all.parts.map((part) => part.id)).toEqual(["other", "other"]);
    expect(contextRows(all).used).toEqual([{ id: "other", tokens: 198_100, percent: expect.closeTo(19.81, 5) }]);
    const later = contextBreakdownOf({ ...breakdown, parts: [{ id: "conversation", tokens: 10_000 }, { id: "added_later", tokens: 5_000, deferred: true }] })!;
    expect(later.parts[1]).toEqual({ id: "other", tokens: 5_000, deferred: true });
    expect(contextRows(later).notLoaded).toBe(5_000);
    expect(contextRows(later).used.map((row) => row.id)).toEqual(["conversation"]);
  });

  it("refuses only an answer that is not a breakdown", () => {
    expect(contextBreakdownOf({ ...breakdown, parts: [{ id: 3, tokens: 3 }] })).toMatchObject({ parts: [{ id: "other", tokens: 3 }] });
    expect(contextBreakdownOf({ ...breakdown, parts: [{ id: "tools", tokens: -1 }, null, { id: "free", tokens: 5 }] })!.parts).toEqual([{ id: "free", tokens: 5 }]);
    expect(contextBreakdownOf({ ...breakdown, parts: "none" })).toBeNull();
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
