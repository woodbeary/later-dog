import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "../server/plan-usage.ts";
import { creditsSpendable } from "./spendable-credits.ts";

describe("spendable credits", () => {
  it.each([
    ["zero", { unlimited: false, balance: "0" }, false],
    ["zero with decimals", { unlimited: false, balance: "0.000" }, false],
    ["negative", { unlimited: false, balance: "-3" }, false],
    ["unknown", { unlimited: false, balance: null }, true],
    ["blank", { unlimited: false, balance: " " }, true],
    ["unreadable", { unlimited: false, balance: "pending" }, true],
    ["positive", { unlimited: false, balance: "49383.7272235000" }, true],
    ["unlimited", { unlimited: true, balance: "0" }, true],
    ["none", undefined, false],
  ] as const)("reads %s credits", (_, credits, spendable) => {
    expect(creditsSpendable(credits)).toBe(spendable);
  });

  it.each([
    [{ has_credits: true, unlimited: false, balance: "12.5" }, true],
    [{ has_credits: true, unlimited: false, balance: 7 }, true],
    [{ has_credits: true, unlimited: false, balance: 0 }, false],
    [{ has_credits: true, unlimited: false, balance: "-3" }, false],
    [{ has_credits: true, unlimited: false, balance: null }, true],
    [{ has_credits: true, unlimited: false }, true],
    [{ has_credits: false, unlimited: false, balance: "50" }, false],
    [{ unlimited: false, balance: "50" }, false],
    [{ has_credits: true, unlimited: true, balance: null }, true],
  ])("matches what the provider reply %j parses into", (credits, spendable) => {
    expect(creditsSpendable(parseCodexUsage({ credits }).credits)).toBe(spendable);
  });
});
