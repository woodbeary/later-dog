import { describe, expect, it } from "vitest";
import { ASK_FIRST_MAX_RULES, ASK_FIRST_RULE_CHARS, askFirstRules } from "./ask-first.ts";

describe("the person's ask-first rules", () => {
  it("keeps tidy, distinct rules in the order written", () => {
    expect(askFirstRules(["  Sending email to   anyone new ", "Buying anything", "sending EMAIL to anyone new", "", 7, null])).toEqual(["Sending email to anyone new", "Buying anything"]);
  });

  it("caps how many rules there are and how long each is", () => {
    const many = Array.from({ length: ASK_FIRST_MAX_RULES + 5 }, (_, index) => `rule ${index}`);
    expect(askFirstRules(many)).toHaveLength(ASK_FIRST_MAX_RULES);
    expect(askFirstRules(["x".repeat(ASK_FIRST_RULE_CHARS + 50)])[0]).toHaveLength(ASK_FIRST_RULE_CHARS);
  });

  it("reads nothing from anything but a list", () => {
    expect(askFirstRules(undefined)).toEqual([]);
    expect(askFirstRules("Buying anything")).toEqual([]);
    expect(askFirstRules({ 0: "x" })).toEqual([]);
  });
});
