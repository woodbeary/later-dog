import { describe, expect, it } from "vitest";

import { anchorShift } from "./scroll-anchor";

describe("holding the place you are reading", () => {
  it("moves the scroll by exactly how far the row you are reading was pushed", () => {
    expect(anchorShift(120, 180)).toBe(60);
    expect(anchorShift(120, 90)).toBe(-30);
  });

  it("ignores sub-pixel noise so nothing creeps", () => {
    expect(anchorShift(120, 120.3)).toBe(0);
    expect(anchorShift(120, 119.6)).toBe(0);
  });
});
