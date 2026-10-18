import { describe, expect, it } from "vitest";

import { LEARN_SOURCE_PREFIX, learnSource } from "./skill-learn.ts";

describe("learnSource", () => {
  it("records the conversation when no source is named", () => {
    expect(learnSource("")).toBe(`${LEARN_SOURCE_PREFIX}conversation`);
    expect(learnSource("   ")).toBe(`${LEARN_SOURCE_PREFIX}conversation`);
  });

  it("keeps one line of at most 180 characters", () => {
    expect(learnSource("  https://docs.example.com/api \n v2 ")).toBe(`${LEARN_SOURCE_PREFIX}https://docs.example.com/api v2`);
    expect(learnSource("x".repeat(400))).toBe(`${LEARN_SOURCE_PREFIX}${"x".repeat(180)}`);
  });
});
