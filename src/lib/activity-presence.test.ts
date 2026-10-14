import { describe, expect, it } from "vitest";

import { presenceElapsed } from "./activity-presence";
import { ROTATE_MS, phrasePool, rowPhrase } from "./thinking-row";
import type { ActivityKind } from "./live-activity";

const KINDS: ActivityKind[] = ["thinking", "reading", "writing", "editing", "running", "searching", "web", "screen", "computer", "page", "team", "working"];

describe("the words on the thinking row", () => {
  it("adds minutes only after the first minute", () => {
    expect(presenceElapsed(59_999)).toBe("");
    expect(presenceElapsed(60_000)).toBe("1m");
    expect(presenceElapsed(3_660_000)).toBe("1h 1m");
  });

  it("has a few plain phrases for every kind of work, none repeated", () => {
    for (const kind of KINDS) {
      const pool = phrasePool(kind);
      expect(pool.length).toBeGreaterThanOrEqual(2);
      expect(new Set(pool).size).toBe(pool.length);
      for (const phrase of pool) expect(phrase.trim()).toBe(phrase);
    }
  });

  it("starts each kind on its first phrase and steps through them at a calm pace", () => {
    const pool = phrasePool("computer");
    expect(rowPhrase("computer", null, 0)).toBe(pool[0]);
    expect(rowPhrase("computer", null, ROTATE_MS - 1)).toBe(pool[0]);
    expect(rowPhrase("computer", null, ROTATE_MS)).toBe(pool[1]);
    expect(rowPhrase("computer", null, ROTATE_MS * pool.length)).toBe(pool[0]);
  });

  it("names clicking around while a dog uses the computer", () => {
    expect(rowPhrase("computer", null, 0)).toBe("Clicking around");
    expect(rowPhrase("thinking", null, 0)).toBe("Thinking it over");
    expect(rowPhrase("reading", null, 0)).toBe("Doing some reading");
  });

  it("prefers what the dog itself says it is doing", () => {
    expect(rowPhrase("computer", "Reading the notes", 30_000)).toBe("Reading the notes");
  });
});
