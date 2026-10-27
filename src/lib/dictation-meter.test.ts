import { describe, expect, it } from "vitest";
import {
  DICTATION_BARS,
  DICTATION_REST_LEVEL,
  dictationClock,
  freshDictationMeter,
  paddedDictationLevels,
  pushDictationLevel,
  stepDictationMeter,
} from "./dictation-meter";

describe("the dictation meter", () => {
  it("rests low while nothing new is heard", () => {
    let meter = freshDictationMeter(0);
    for (let i = 0; i < 5; i++) meter = stepDictationMeter(meter, 0);
    expect(meter.levels).toHaveLength(5);
    for (const level of meter.levels) expect(level).toBeCloseTo(DICTATION_REST_LEVEL);
  });

  it("jumps when words arrive and settles back down after", () => {
    let meter = stepDictationMeter(freshDictationMeter(0), 12);
    expect(meter.levels.at(-1)!).toBeGreaterThan(0.4);
    for (let i = 0; i < 30; i++) meter = stepDictationMeter(meter, 12);
    expect(meter.levels.at(-1)!).toBeLessThan(DICTATION_REST_LEVEL + 0.02);
  });

  it("starts from what was already in the box, so typed text is not a burst", () => {
    const meter = stepDictationMeter(freshDictationMeter(40), 40);
    expect(meter.levels[0]).toBeCloseTo(DICTATION_REST_LEVEL);
  });

  it("ignores the box getting shorter", () => {
    const meter = stepDictationMeter(freshDictationMeter(20), 5);
    expect(meter.levels[0]).toBeCloseTo(DICTATION_REST_LEVEL);
    expect(meter.heard).toBe(5);
  });

  it("keeps levels between 0 and 1 and only the newest bars", () => {
    let levels: number[] = [];
    for (let i = 0; i < DICTATION_BARS + 6; i++) levels = pushDictationLevel(levels, i === 0 ? 3 : -1);
    expect(levels).toHaveLength(DICTATION_BARS);
    expect(levels.every((level) => level === 0)).toBe(true);
    expect(pushDictationLevel([], 4)).toEqual([1]);
  });

  it("pads the front with empty bars so new sound enters from the right", () => {
    expect(paddedDictationLevels([0.5], 3)).toEqual([0, 0, 0.5]);
    expect(paddedDictationLevels([0.1, 0.2, 0.3, 0.4], 3)).toEqual([0.2, 0.3, 0.4]);
  });

  it("shows minutes and seconds", () => {
    expect(dictationClock(0)).toBe("0:00");
    expect(dictationClock(7_900)).toBe("0:07");
    expect(dictationClock(65_000)).toBe("1:05");
    expect(dictationClock(-5)).toBe("0:00");
  });
});
