import { describe, expect, it } from "vitest";

import { botUsage, costCaption, formatTokens, formatUsd, headlineTokens, sumUsage, tokensColumnLabel } from "./usage";

describe("usage formatting", () => {
  it("sums complete cache reports without losing an explicit zero", () => {
    const usage = { input: 100, output: 8, costUsd: null, turns: 1, cachedInput: 0 };
    expect(sumUsage([usage, { ...usage, cachedInput: 50 }]).cachedInput).toBe(50);
    expect(sumUsage([usage, { ...usage, input: 0, cachedInput: undefined }]).cachedInput).toBe(0);
    expect(sumUsage([usage, { ...usage, cachedInput: Number.NaN }]).cachedInput).toBeUndefined();
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("treats NaN and Infinity as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatUsd(undefined as unknown as number)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("does not invent a cache split when some input has no cache report", () => {
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, costUsd: null, turns: 2 });
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });

  it("counts new tokens when the cache is reported, and all tokens otherwise", () => {
    const longThread = { input: 1_900_000, output: 12_000, cachedInput: 1_862_000, costUsd: null, turns: 12 };
    expect(headlineTokens(longThread)).toBe(50_000);
    expect(headlineTokens({ input: 1_900_000, output: 12_000, costUsd: null, turns: 12 })).toBe(1_912_000);
  });

  it("labels a fresh-token total as new tokens and a raw total as tokens", () => {
    const total = sumUsage([
      { turns: 900, input: 300_000_000, cachedInput: 299_100_000, output: 400_000, costUsd: null },
      { turns: 700, input: 199_000_000, cachedInput: 198_400_000, output: 200_000, costUsd: null },
    ]);
    expect(formatTokens(headlineTokens(total))).toBe("2.1M");
    expect(tokensColumnLabel(total)).toBe("New tokens");
    expect(tokensColumnLabel({ input: 1_900_000, output: 12_000, costUsd: null, turns: 12 })).toBe("Tokens");
  });
});
