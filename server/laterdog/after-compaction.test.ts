import { describe, expect, it } from "vitest";

import { CARRY_MAX_BYTES, CompactionCarry, carriedSections } from "./after-compaction.ts";

const section = (id: string, text: string) => ({ id, label: id, text });

describe("what a dog is given back after the engine compacts", () => {
  it("carries only the profile and the connected apps, in order, and nothing empty", () => {
    const carried = carriedSections([section("memory", "m"), section("connected", " mail "), section("user-profile", "  "), section("user-profile", "p")]);
    expect(carried.map((item) => item.id)).toEqual(["connected", "user-profile"]);
  });

  it("cuts a section that would pass the cap instead of leaving it out, and keeps the smaller ones whole", () => {
    const big = "é".repeat(CARRY_MAX_BYTES);
    const carried = carriedSections([section("user-profile", big), section("connected", "mail is connected")]);
    expect(carried.map((item) => item.id)).toEqual(["user-profile", "connected"]);
    expect(carried[1]!.text).toBe("mail is connected");
    expect(carried[0]!.text.length).toBeGreaterThan(1000);
    expect(carried[0]!.text).toMatch(/^é+$/);
    const carry = new CompactionCarry();
    carry.remember("b1", "t1", [section("user-profile", big), section("connected", "mail is connected")]);
    const text = carry.context("b1", "t1");
    expect(text).toContain("mail is connected");
    expect(text).toContain("éééé");
    expect(text).not.toContain("\uFFFD");
    const body = carried.map((item) => `[${item.label}]\n${item.text.trim()}`).join("");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(CARRY_MAX_BYTES);
  });
});
