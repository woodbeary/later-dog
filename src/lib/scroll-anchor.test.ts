// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { anchorShift, boxOf } from "./scroll-anchor";

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

describe("measuring a row that is only a wrapper", () => {
  const rectOf = (height: number, top = 0) => () => ({ height, top, bottom: top + height }) as DOMRect;

  it("measures the first child with a height when the wrapper itself has none", () => {
    const wrapper = document.createElement("div");
    wrapper.getBoundingClientRect = rectOf(0);
    const empty = document.createElement("span");
    empty.getBoundingClientRect = rectOf(0);
    const bubble = document.createElement("div");
    bubble.getBoundingClientRect = rectOf(40, 120);
    wrapper.append(empty, bubble);
    expect(boxOf(wrapper)?.top).toBe(120);
  });

  it("measures the wrapper when it has a height of its own, and nothing when it has none anywhere", () => {
    const solid = document.createElement("div");
    solid.getBoundingClientRect = rectOf(30, 10);
    expect(boxOf(solid)?.top).toBe(10);
    const hollow = document.createElement("div");
    hollow.getBoundingClientRect = rectOf(0);
    expect(boxOf(hollow)).toBeNull();
  });
});
