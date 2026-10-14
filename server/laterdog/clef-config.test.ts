import { describe, expect, it } from "vitest";

import { parseConfigPatch } from "../config.ts";
import { autoReviewRules, describeClef } from "./clef-config.ts";

const KEY = "tsk_unit_secret_key_0123456789abcdef";

describe("Auto-review rules in the config", () => {
  it("accepts up to 20 allow and 20 block rules of up to 1,000 characters and trims them", () => {
    const rules = { allow: Array.from({ length: 20 }, (_, index) => ` rule ${index} `), block: ["x".repeat(1_000)] };
    const parsed = parseConfigPatch({ decider: { autoReview: rules } }).decider?.autoReview;
    expect(parsed?.allow).toHaveLength(20);
    expect(parsed?.allow[0]).toBe("rule 0");
    expect(parsed?.block[0]).toHaveLength(1_000);
  });

  it("refuses a 21st rule, a rule over 1,000 characters and an empty rule", () => {
    expect(() => parseConfigPatch({ decider: { autoReview: { allow: Array.from({ length: 21 }, () => "ok"), block: [] } } })).toThrow();
    expect(() => parseConfigPatch({ decider: { autoReview: { allow: [], block: ["x".repeat(1_001)] } } })).toThrow();
    expect(() => parseConfigPatch({ decider: { autoReview: { allow: ["   "], block: [] } } })).toThrow();
  });

  it("reads clean rules even from a hand-edited file", () => {
    const rules = autoReviewRules({ decider: { autoReview: { allow: ["  a   b ", "", 7 as unknown as string], block: Array.from({ length: 30 }, () => "z") } } });
    expect(rules.allow).toEqual(["a b"]);
    expect(rules.block).toHaveLength(20);
    expect(autoReviewRules({})).toEqual({ allow: [], block: [] });
  });

  it("tells Settings whether rules can take effect, without any key", () => {
    expect(describeClef({})).toEqual({
      ready: false,
      autoReview: { allow: [], block: [] },
      jobs: { autoReview: true, turnEnd: true, screenCheck: true, screenshotFilter: true },
    });
    const on = describeClef({ decider: { enabled: true, key: KEY, model: "clef-flash", autoReview: { allow: ["a"], block: [] }, jobs: { turnEnd: false } } });
    expect(on).toMatchObject({ ready: true, model: "clef-flash", autoReview: { allow: ["a"], block: [] }, jobs: { turnEnd: false, autoReview: true } });
    expect(JSON.stringify(on)).not.toContain(KEY);
    expect(describeClef({ decider: { enabled: true, key: KEY, jobs: { autoReview: false } } }).ready).toBe(false);
  });
});
