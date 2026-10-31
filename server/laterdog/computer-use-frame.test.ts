import { describe, expect, it } from "vitest";
import { frameSize, toFrame, toScreen, visualTokens, withinToolsetLimits } from "./computer-use-frame.ts";

describe("screenshot size for the computer toolset", () => {
  it("sends later.dog's 1280x800 cloud desktop at its own size", () => {
    expect(frameSize({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  });

  it("shrinks a larger screen into 1920x1080 and keeps its shape", () => {
    expect(frameSize({ width: 2560, height: 1600 })).toEqual({ width: 1728, height: 1080 });
    expect(frameSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 });
    expect(frameSize({ width: 3024, height: 1964 })).toEqual({ width: 1663, height: 1080 });
    expect(frameSize({ width: 1170, height: 2532 })).toEqual({ width: 887, height: 1920 });
  });

  it("never enlarges a small screen", () => {
    expect(frameSize({ width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 });
  });

  it("keeps every frame inside the toolset's limits of 2,576 px and 4,784 visual tokens", () => {
    for (const screen of [{ width: 1280, height: 800 }, { width: 7680, height: 4320 }, { width: 5120, height: 1440 }, { width: 1080, height: 7680 }]) {
      const frame = frameSize(screen);
      expect(withinToolsetLimits(frame), `${frame.width}x${frame.height}`).toBe(true);
    }
    expect(visualTokens({ width: 1920, height: 1080 })).toBe(69 * 39);
    expect(withinToolsetLimits({ width: 2600, height: 100 })).toBe(false);
    expect(withinToolsetLimits({ width: 2576, height: 2576 })).toBe(false);
  });

  it("refuses a screen size that cannot be real", () => {
    expect(() => frameSize({ width: 0, height: 800 })).toThrow("unusable screen size");
    expect(() => frameSize({ width: 1280.5, height: 800 })).toThrow("unusable screen size");
  });
});

describe("mapping Claude's coordinates back to the screen", () => {
  const screen = { width: 2560, height: 1600 };
  const frame = frameSize(screen);

  it("scales a point in the screenshot to the same place on the screen", () => {
    expect(toScreen([864, 540], frame, screen)).toEqual([1280, 800]);
    expect(toScreen([0, 0], frame, screen)).toEqual([0, 0]);
    expect(toScreen([1728, 1080], frame, screen)).toEqual([2559, 1599]);
  });

  it("is the identity when the screenshot is the screen", () => {
    const same = { width: 1280, height: 800 };
    expect(toScreen([640, 400], same, same)).toEqual([640, 400]);
    expect(toFrame([640, 400], same, same)).toEqual([640, 400]);
  });

  it("reports the pointer in screenshot pixels", () => {
    expect(toFrame([1280, 800], frame, screen)).toEqual([864, 540]);
    expect(toFrame([2559, 1599], frame, screen)).toEqual([1727, 1079]);
  });
});
