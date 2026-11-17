import { describe, expect, it } from "vitest";
import { restingFor } from "./account-rests";

const NOW = Date.parse("2026-11-14T18:49:00Z");
const MONDAY_NINE = "2026-11-16T17:00:00.000Z";
const SINCE = "2026-11-14T18:00:00.000Z";
const fable = { model: "Fable", label: "Fable weekly limit", until: MONDAY_NINE, since: SINCE, kind: "seven_day_overage_included" };

describe("which accounts rest for the model a dog runs", () => {
  it("shows daniel resting until Monday for a Fable dog, and free for an Opus dog", () => {
    const battery = { resting: {}, modelResting: { daniel: [fable] } };
    expect(restingFor(battery, "claude-fable-5-1", NOW)).toEqual({ daniel: fable });
    expect(restingFor(battery, "claude-opus-5-5", NOW)).toEqual({});
    expect(restingFor(battery, undefined, NOW)).toEqual({});
  });

  it("keeps a whole-account rest first, and picks the model's rest once the whole-account rest is over", () => {
    const whole = { until: "2026-11-14T23:49:00.000Z", since: SINCE, kind: "session" };
    expect(restingFor({ resting: { daniel: whole }, modelResting: { daniel: [fable] } }, "claude-fable-5-1", NOW)).toEqual({ daniel: whole });
    const over = { ...whole, until: "2026-11-14T18:00:00.000Z" };
    expect(restingFor({ resting: { daniel: over }, modelResting: { daniel: [fable] } }, "claude-fable-5-1", NOW)).toEqual({ daniel: fable });
    expect(restingFor({ resting: { daniel: over }, modelResting: { daniel: [fable] } }, "claude-opus-5-5", NOW)).toEqual({ daniel: over });
  });

  it("reads like today when the home sends no model rests", () => {
    const whole = { until: MONDAY_NINE, kind: "seven_day_overage_included" };
    expect(restingFor({ resting: { daniel: whole } }, "claude-fable-5-1", NOW)).toEqual({ daniel: whole });
    expect(restingFor(undefined, "claude-fable-5-1", NOW)).toEqual({});
  });
});
