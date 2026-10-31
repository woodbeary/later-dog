import { describe, expect, it } from "vitest";
import { formatActivity } from "./DogActivity";

describe("a dog's activity numbers", () => {
  it("shows time working as a duration and everything else as a count", () => {
    expect(formatActivity("workedSeconds", 3_900)).toBe("1h 5m");
    expect(formatActivity("workedSeconds", 45)).toBe("45s");
    expect(formatActivity("sent", 12)).toBe("12");
    expect(formatActivity("turns", 1_500)).toBe("1.5k");
  });
});
