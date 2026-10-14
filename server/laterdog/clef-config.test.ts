import { describe, expect, it } from "vitest";

import { parseConfigPatch } from "../config.ts";
import { CLEF_WIDENING_REFUSAL, autoReviewRules, clefWidening, clefWideningRefusal, describeClef } from "./clef-config.ts";

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

  it("tells Settings what is on, what could run, and where things are sent", () => {
    expect(describeClef({})).toEqual({
      ready: false,
      sendsTo: "api.typesafe.ai",
      available: { autoReview: false, turnEnd: false, screenCheck: false, screenshotFilter: false },
      autoReview: { allow: [], block: [] },
      jobs: { autoReview: false, turnEnd: false, screenCheck: false, screenshotFilter: false },
    });
    const on = describeClef({ decider: { enabled: true, key: KEY, baseUrl: "https://clef.example.test/v1", model: "clef-flash", autoReview: { allow: ["a"], block: [] }, jobs: { turnEnd: true, autoReview: true } } });
    expect(on).toMatchObject({
      ready: true, model: "clef-flash", sendsTo: "clef.example.test", autoReview: { allow: ["a"], block: [] },
      jobs: { turnEnd: true, autoReview: true, screenCheck: false },
      available: { autoReview: true, screenCheck: true },
    });
    expect(JSON.stringify(on)).not.toContain(KEY);
  });

  it("keeps the new jobs off until they are switched on, even with a saved key", () => {
    expect(describeClef({ decider: { enabled: true, key: KEY } }).jobs).toEqual({ autoReview: false, turnEnd: false, screenCheck: false, screenshotFilter: false });
    expect(describeClef({ decider: { enabled: true, key: KEY, jobs: { autoReview: false } } }).ready).toBe(false);
    expect(describeClef({ decider: { enabled: true, key: KEY, jobs: { autoReview: true } } }).ready).toBe(true);
  });

  it("needs an endpoint that reads images before the screen jobs can run", () => {
    expect(describeClef({ decider: { enabled: true, key: KEY, jobs: { screenCheck: true } } }).available.screenCheck).toBe(false);
    expect(describeClef({ decider: { enabled: true, key: KEY, baseUrl: "https://clef.example.test", jobs: { screenCheck: true } } }).available.screenCheck).toBe(true);
  });
});

describe("what loosens the rules", () => {
  const current = { enabled: true, key: KEY, autoReview: { allow: ["a", "b"], block: ["x", "y"] }, jobs: { turnEnd: true } };

  it("flags a new allow rule, a removed block rule, and a job turned on", () => {
    expect(clefWidening(current, { autoReview: { allow: ["a", "b", "c"], block: ["x", "y"] } })).toEqual(["autoReview.allow"]);
    expect(clefWidening(current, { autoReview: { allow: ["a"], block: ["x"] } })).toEqual(["autoReview.block"]);
    expect(clefWidening(current, { jobs: { turnEnd: true, screenCheck: true } })).toEqual(["jobs.screenCheck"]);
    expect(clefWidening(undefined, { jobs: { autoReview: true }, autoReview: { allow: ["z"], block: [] } })).toEqual(["autoReview.allow", "jobs.autoReview"]);
  });

  it("lets tightening through: fewer allow rules, more block rules, jobs turned off", () => {
    expect(clefWidening(current, { autoReview: { allow: ["a"], block: ["x", "y", "z"] }, jobs: { turnEnd: false } })).toEqual([]);
    expect(clefWidening(current, { autoReview: { allow: [" a ", "b"], block: ["x", "y"] } })).toEqual([]);
    expect(clefWidening(current, {})).toEqual([]);
  });
});

describe("who may loosen the rules", () => {
  const current = { enabled: true, key: KEY, autoReview: { allow: ["a"], block: ["x"] }, jobs: {} };
  const script = { appOrPairedDevice: false, dogsWorking: true };

  it("refuses a script on this machine, while dogs work, that adds an allow rule, removes a block rule or turns a job on", () => {
    expect(clefWideningRefusal(current, { autoReview: { allow: ["a", "b"], block: ["x"] } }, script)).toBe(CLEF_WIDENING_REFUSAL);
    expect(clefWideningRefusal(current, { autoReview: { allow: ["a"], block: [] } }, script)).toBe(CLEF_WIDENING_REFUSAL);
    expect(clefWideningRefusal(current, { jobs: { autoReview: true } }, script)).toBe(CLEF_WIDENING_REFUSAL);
  });

  it("refuses pointing the decisions at another address or key the same way", () => {
    expect(clefWideningRefusal(current, { baseUrl: "https://elsewhere.example.test" }, script)).toBe(CLEF_WIDENING_REFUSAL);
    expect(clefWideningRefusal(current, { key: "tsk_other_key_0123456789" }, script)).toBe(CLEF_WIDENING_REFUSAL);
    expect(clefWideningRefusal(current, { key: KEY }, script)).toBeNull();
  });

  it("lets the app and paired devices through, and lets a script tighten", () => {
    const loosening = { autoReview: { allow: ["a", "b"], block: [] }, jobs: { turnEnd: true } };
    expect(clefWideningRefusal(current, loosening, { appOrPairedDevice: true, dogsWorking: true })).toBeNull();
    expect(clefWideningRefusal(current, loosening, { appOrPairedDevice: false, dogsWorking: false })).toBeNull();
    expect(clefWideningRefusal(current, { autoReview: { allow: [], block: ["x", "y"] }, jobs: { turnEnd: false } }, script)).toBeNull();
    expect(clefWideningRefusal(current, undefined, script)).toBeNull();
  });
});
